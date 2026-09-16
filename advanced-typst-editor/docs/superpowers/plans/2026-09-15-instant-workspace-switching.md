# Instant workspace switching: implementation plan

Spec: `docs/superpowers/specs/2026-09-15-instant-workspace-switching-design.md`. Branch `typst-switch-perf`. Every task ends with `bun run test:server`, `bun run test:ui` and `bun run typecheck` green, then one commit.

## Task 1: settings cache and lazy `openedAt`

Files: `server/settings.ts`, `server/settings.test.ts`, `server/index.ts` (flush on `SIGINT`/`SIGTERM`).

- Cache the normalised settings in memory. `get()` stats the file at most once per second and re-reads only when the mtime moved; writes update the cache and record the new mtime.
- Add `touchWorkspace(id)` (in-memory `openedAt`, debounced 2 s write) and `flush()`.
- Tests: memory hit, external edit picked up, touch then flush.

## Task 2: workspace index

Files: `server/workspace-index.ts` (new), `server/workspace-index.test.ts` (new), `server/workspace.ts` (export the pure asset and folder mappers so both walks share them).

- Async snapshot builder; shared in-flight build; `invalidate`, `touch`, `maxAgeMs`; etag.
- Tests as listed in the spec.

## Task 3: service and router on the index

Files: `server/service.ts`, `server/router.ts`, `server/mcp-tools.ts` and anything else that calls `detail()` (make them await), `src/types.ts` (`etag` on `WorkspaceDetail`), `server/service.test.ts`, `server/router.test.ts`.

- `detail` async through the index; bus subscription for touch/invalidate; rename and remove invalidate.
- Detail route: `ETag` header, 304. File GET via `fs.promises`. `PUT` returns `{ ok, etag }`.

## Task 4: client instrumentation

Files: `src/lib/perf.ts` (new), `src/test/perf.test.ts` (new).

- `switchTrace.start(id)`, `mark(name)`, `window.__tfsPerf`, one-line log gated on dev or `localStorage['tfs-perf']`.

## Task 5: client caches and store

Files: `src/lib/workspace-cache.ts` (new), `src/test/workspace-cache.test.ts` (new), `src/api/client.ts` (`getWorkspace(id, etag?)` returning null on 304; `readText` with `ifNoneMatch`; `writeText` returning the etag), `src/stores/index.ts`, `src/test/store.test.ts`.

- Caches, LRU, `mergeDetail`.
- `selectWorkspace` from cache plus conditional revalidation; stale-response guard; invalidation on events.

## Task 6: source text cache in the file hook

Files: `src/hooks/use-workspace-file.ts`, `src/test/use-workspace-file.test.ts`.

- Derived-state reset on key change; cached text presented synchronously; conditional reload; cache updated on load and save.

## Task 7: mount logic module and asset byte caches

Files: `src/lib/typst-mount.ts` (new), `src/lib/typst-assets.ts`, `src/components/typst/TypstView.tsx`, `src/test/typst-assets.test.ts`, `src/test/typst-mount.test.ts` (new).

- Move `MOUNTABLE_EXTS`, `MAX_MOUNT_BYTES`, `readPlainFile` and a pure `collectMounts` into `typst-mount.ts`.
- `fetchAssetBytesFor(wsId, asset)` and `resolveAssetBytes(asset, wsId?)`; workspace id in every cache key; raw LRU 64.
- `useTypstAssetSync` returns `{ revision, ready }`; remove the duplicate detail load.

## Task 8: preview snapshot and immediate compile

Files: `src/components/typst/TypstPreview.tsx`, `src/components/typst/TypstView.tsx`, `src/test/typst-preview-pages.test.tsx`.

- `docKey` and `ready` props; render cache save/restore with scroll offset; immediate compile on a new key, debounce otherwise; rendering state instead of the stale document.
- Perf marks at compile start, compile done and paint.

## Task 9: prefetch

Files: `src/lib/prefetch.ts` (new), `src/test/prefetch.test.ts` (new), `src/components/sidebar/Sidebar.tsx`, `src/test/sidebar.test.tsx`, `src/App.tsx`.

- `prefetchWorkspace`, hover intent, idle scheduler with caps.

## Task 10: verification and deployment

- Foreground Chrome measurement of the switch traces before and after (`window.__tfsPerf`).
- `docker compose up --build -d`, health check, the same switches against the container.
- Update the README's tests section if commands changed (they do not).
