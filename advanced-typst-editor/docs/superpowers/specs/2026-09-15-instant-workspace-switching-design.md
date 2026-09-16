# Typst Studio: instant workspace switching

Date: 2026-09-15. Branch: `typst-switch-perf` (off `main`). Approved by the user in chat: implement phases 0 to 2, keep Docker as the deployment, leave font handling as it is, prefetch on hover and on idle.

## 1. Goal

Clicking a workspace in the sidebar shows that workspace's editor text and rendered preview at once, and the app never blocks on the server for something it already has.

Targets, measured with the Chrome tab in the foreground:

| Case | Target |
|---|---|
| Click on a workspace visited or prefetched this session | new document on screen in under 100 ms |
| First visit to a workspace | one detail round trip plus one compile, no second compile |
| Workspace detail request served from the container | under 5 ms when the index is warm |
| Typing with a 23-page report open | no request or re-render outside the compile and the autosave |

## 2. Findings that drive the design

Measured on 2026-09-15 against the running container at `localhost:8090` and against a native Bun server on a scratch copy of the same data. The Chrome tab was in a background window, which clamps browser timers to 1 s, so only network timings, server timings and synchronous DOM costs are quoted.

| Observation | Value |
|---|---|
| `GET /api/workspaces/:id` (detail), container | 115 to 155 ms, every call |
| Same request, native server | 7 to 10 ms |
| Detail requests per sidebar click | 2 (`selectWorkspace` and `useTypstAssetSync`) |
| `GET main.typ` from the browser during a switch | 96 to 143 ms; 17 ms alone with curl |
| Image and font reads during a switch | 150 to 300 ms each |
| Preview debounce before the first compile after a switch | 350 ms, fixed |
| Mounting a visible page (parse, style, layout) | 4 ms and 34 ms |

Causes:

- `service.detail()` walks the workspace with synchronous `readdirSync` and `statSync`, stats every asset a second time for its birth time, reads `workspace.json`, and then rewrites `settings.json` (write plus rename) just to bump `openedAt`. Bun runs one event loop, so every other request queues behind that walk. On the Docker Desktop bind mount each filesystem call is roughly 15 times slower than on a native disk.
- `settings.get()` reads and parses `settings.json` from disk on every call, several times per request.
- The client discards everything on a click: it nulls the detail, fetches it twice, fetches the source, re-resolves every asset, then waits 350 ms before compiling. The source and the assets arrive on separate paths, so the first compile can run before the images are mounted and a second compile follows.
- The previous workspace's preview stays on screen until the new compile lands, which reads as lag.
- Every autosave triggers a `workspace.changed` event and, 150 ms later, another full detail walk plus a fresh `detail` object, which re-renders the tab while the user types.

Rendering is not the bottleneck: pages mount in tens of milliseconds and unchanged pages already keep their DOM.

## 3. Architecture

### 3.1 Server

**Settings cache** (`server/settings.ts`). The parsed settings live in memory. `get()` returns the cached value; it stats the file at most once per second and re-reads only when the mtime moved (an edit from outside the process). Every write updates the cache and records the resulting mtime. New `touchWorkspace(id)` sets `openedAt` in memory, returns the entry, and flushes to disk after 2 s of quiet; `flush()` writes immediately (used at shutdown and in tests).

**Workspace index** (`server/workspace-index.ts`, new). One snapshot per workspace root: `{ files, meta, assets, folders, etag, builtAt }`. Built with `fs.promises` (one `readdir` per directory, one `stat` per file, the birth time taken from that same stat). Concurrent requests share one in-flight build. Operations:

- `get(root)`: the cached snapshot, rebuilt when absent, invalidated, or older than `maxAgeMs` (30 s, a safety net for edits the watcher never reports, such as host-side edits through the bind mount).
- `invalidate(root)`.
- `touch(root, rel)`: a plain file changed. Recorded synchronously; the next `get` re-stats just that file and patches its entry (or drops it). A change under `assets/` or `fonts/`, to `workspace.json`, or to a directory invalidates the whole snapshot instead.
- `etag`: a short hash of the files list and the meta, so the client can revalidate with `If-None-Match`.

**Service** (`server/service.ts`). `detail(id)` becomes async: `{ entry: settings.touchWorkspace(id), ...index.get(root) }`. The service subscribes to its own event bus: every `workspace.changed` for a workspace touches or invalidates its snapshot, whichever the paths call for, whether the event came from the server's own write or from the watcher. Rename and remove invalidate. `WorkspaceDetail` gains `etag: string`.

**Router** (`server/router.ts`). The detail route sends an `ETag` header and answers 304 to a matching `If-None-Match`. File reads use `fs.promises`, keeping the existing ETag and 304 behaviour, so a slow bind-mount read no longer blocks the loop. `PUT` on a file returns the new etag so the client's text cache stays exact.

### 3.2 Client

**Instrumentation** (`src/lib/perf.ts`, new). `switchTrace.start(id)` on the click and `mark(name)` for `detail`, `source`, `assets`, `compiled`, `painted`. Traces are kept on `window.__tfsPerf` (last 20) and logged as one line in dev or when `localStorage['tfs-perf']` is `'1'`.

**Caches** (`src/lib/workspace-cache.ts`, new).

- `detailCache: Map<id, WorkspaceDetail>`. Unbounded; entries are a few KB.
- `textCache: Map<docKey, { text, etag | null }>` for opened `.typ` files.
- `renderCache`: LRU keyed by `docKey` holding the last good SVG, its diagnostics and the preview's scroll offset, bounded to 32 million characters in total (about ten long reports).
- `mergeDetail(prev, next)`: structural sharing. Asset records, the assets array, the folders array and the meta keep their previous object identity when their JSON is equal, so React memoization stays effective when only a file's mtime changed.
- Invalidation: a `workspace.changed` event for a workspace that is not active drops its entries from all three caches; `workspaces.changed` clears the detail cache.

**Store** (`src/stores/index.ts`). `selectWorkspace(id)` sets the cached detail immediately when there is one (no null flash) and revalidates with the cached etag; a 304 changes nothing, a 200 is merged and applied. A response for a workspace that is no longer active is ignored. The second detail fetch from `useTypstAssetSync` is removed.

**Source text** (`src/hooks/use-workspace-file.ts`). On a key change the hook presents the cached text synchronously (derived state during render, so the preview never sees the old text under the new key) and revalidates with `If-None-Match`; a 200 is applied only while the buffer is clean. Loads and saves update the cache with the etag the server reports.

**Asset sync** (`src/components/typst/TypstView.tsx`, `src/lib/typst-mount.ts` new). The mount logic (which files to mount, byte resolution, the plain-file cache) moves into `typst-mount.ts` so the prefetcher can reuse it. `useTypstAssetSync` returns `{ revision, ready }`; `ready` is true only after a sync completed against a detail that belongs to the current workspace. The byte caches in `typst-assets.ts` take the workspace id and the asset record explicitly (needed for prefetch), keys include the workspace id, and the raw LRU grows to 64 entries.

**Preview** (`src/components/typst/TypstPreview.tsx`). New props `docKey` and `ready`. On a `docKey` change the outgoing render is stored in `renderCache` and the incoming document's snapshot (if any) is shown at once with its scroll offset restored; without a snapshot the page area shows the rendering state rather than the previous document. The compile effect does nothing while `ready` is false; the first compile for a new `docKey` runs immediately, later compiles keep the 350 ms debounce.

**Prefetch** (`src/lib/prefetch.ts`, new). `prefetchWorkspace(id)` fills the detail cache, the text cache for the document that would open, and the asset and plain-file byte caches. One in-flight prefetch per id. Two triggers:

- Hover: a sidebar row starts an 80 ms intent timer on pointer enter and cancels it on leave.
- Idle: after the initial workspace loads, `requestIdleCallback` (fallback 2 s timeout) prefetches every other `ok` workspace in `openedAt` order, one at a time, capped at 20 workspaces and 64 MB of asset bytes.

Prefetch never compiles: the worker's font and shadow state belongs to the active document, and font handling stays as it is.

### 3.3 Data flow after the change

Click on a workspace visited before:

1. Sidebar click → `selectWorkspace` → cached detail applied synchronously → `useWorkspaceFile` presents the cached text → the preview shows the cached render with its scroll offset. All in the same frame.
2. `useTypstAssetSync` resolves bytes from cache → `ready` → the preview compiles once, immediately → changed pages are swapped, unchanged pages keep their DOM.
3. In the background: conditional detail request (304 when nothing changed), conditional source request (304).

First visit without a prefetch:

1. Click → detail request (a few ms from the warm index) and source request in parallel → editor text appears.
2. Asset bytes fetched in parallel → `ready` → one compile → pages appear.

## 4. Error handling

- A failed revalidation keeps the cached data and logs nothing louder than a console warning; the existing `missing` state in the sidebar still covers a vanished folder.
- The index treats a file that vanished between `readdir` and `stat` as absent, as the walk does today.
- A prefetch failure is dropped silently and retried on the next trigger.
- The render cache stores only successful renders; a document whose last compile failed shows its error banner again after the next compile, as today.
- The debounced `openedAt` flush is best effort: a crash inside the 2 s window loses at most that timestamp.

## 5. Testing

Server (`vitest --project server`):

- `workspace-index.test.ts`: snapshot equals the synchronous listing; `touch` patches one file without a rebuild; asset, font, `workspace.json` and directory changes rebuild; `maxAgeMs` expiry; concurrent gets share one build; etag stable across identical builds and different after a change.
- `settings.test.ts`: `get` serves from memory and picks up an external edit; `touchWorkspace` updates `openedAt` in memory and writes after the quiet period; `flush` writes at once.
- `router.test.ts`: detail carries `ETag` and answers 304; file GET stays correct through the async read; `PUT` returns the etag.
- `service.test.ts`: a write through the service invalidates or patches the index and the next detail reflects it.

UI (`vitest --project ui`):

- `workspace-cache.test.ts`: LRU eviction by character budget; `mergeDetail` keeps identities when equal and replaces when not.
- `store.test.ts`: cached detail applied synchronously on select; conditional request; late response for an inactive workspace ignored; inactive change event drops the caches.
- `use-workspace-file.test.ts`: cached text shown without a loading state; revalidation applies a 200 only when clean.
- `typst-preview-pages.test.tsx`: no compile while `ready` is false; immediate compile on a `docKey` change; cached render shown at once; debounce kept for typing.
- `prefetch.test.ts`: hover intent timer and cancel; idle order, cap and byte budget; one in-flight prefetch per id.
- `sidebar.test.tsx`: hovering a row triggers the prefetch.

Manual, in Chrome with the tab in the foreground: switch between `cptc-report`, `ece-2300L-lab2` and `ccdc-inject-template`; read `window.__tfsPerf`; confirm revisits under 100 ms and one compile per switch; confirm typing produces no detail request beyond the conditional one after autosave. Then `docker compose up --build -d` and repeat against the container.

## 6. Out of scope

- Font union or per-font-set resolver caching: fonts stay as they are.
- Incremental compilation (`IncrServer`) and DOM-patching render: typing latency, not switching.
- Replacing the bind mount with a named volume.
- Precompiling prefetched workspaces.
