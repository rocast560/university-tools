// Shared by the browser (src/) and the server (server/): no DOM, no Node.
export type ID = string;
export type TypstAssetKind = 'image' | 'font';

/** Normalised crop rect relative to the original image; may extend outside 0..1. */
export interface CropRect { x: number; y: number; w: number; h: number }
export type BlurStyle = 'gaussian' | 'pixelate';
/** Redaction region inside the unit square of the original image. */
export interface BlurRegion { x: number; y: number; w: number; h: number; style?: BlurStyle; strength?: number }

/** Per-image framing stored in workspace.json under the asset id. */
export interface AssetMeta {
  crop?: CropRect | null;
  blurs?: BlurRegion[] | null;
  width?: number | null;
  height?: number | null;
}
export interface FontMeta { family: string | null }
export interface WorkspaceJson {
  version: 1;
  /** keyed by asset id (workspace-relative path, e.g. "assets/findings/login.png") */
  assets: Record<string, AssetMeta>;
  /** keyed by asset id, e.g. "fonts/Inter-Regular.ttf" */
  fonts: Record<string, FontMeta>;
}

/**
 * One image or font in a workspace. `id` is the workspace-relative path
 * ("assets/findings/login.png", "fonts/Inter.ttf"); the Typst path is "/" + id.
 * `folderId` is the directory relative to assets/ ("findings", "findings/auth")
 * or null at the root. `etag` changes whenever the bytes change.
 */
export interface TypstAsset {
  id: ID;
  kind: TypstAssetKind;
  filename: string;
  mime: string;
  size: number;
  etag: string;
  width?: number | null;
  height?: number | null;
  crop?: CropRect | null;
  blurs?: BlurRegion[] | null;
  fontFamily?: string | null;
  folderId: ID | null;
  createdAt: number;
  updatedAt: number;
}

/** A subdirectory of assets/. `id` is its path relative to assets/. */
export interface AssetFolder { id: ID; name: string; parentId: ID | null; createdAt: number; updatedAt: number }

export interface WorkspaceEntry {
  id: ID;
  path: string;
  name: string;
  group: string | null;
  library: boolean;
  createdAt: number;
  openedAt: number;
  /** The document this one is nested under in the sidebar (never on disk). Always in the same `group` as its parent. */
  parent?: ID | null;
  /** Icon, colour and logo of this document's sidebar row. */
  appearance?: FolderMeta;
}
export interface WorkspaceStatus extends WorkspaceEntry { status: 'ok' | 'missing' }
export interface FileEntry { path: string; size: number; mtime: number }
export interface WorkspaceDetail {
  entry: WorkspaceEntry;
  files: FileEntry[];
  meta: WorkspaceJson;
  assets: TypstAsset[];
  folders: AssetFolder[];
  /** Changes whenever files or meta change; send it back as If-None-Match to get a 304. */
  etag: string;
}

export interface BackupDestination { id: ID; path: string; mirror: boolean; snapshots: boolean }
export interface BackupSettings { destinations: BackupDestination[]; snapshotIntervalMin: number; keepSnapshots: number }
export interface BackupState extends BackupSettings {
  running: boolean;
  lastRunAt: number | null;
  lastMirrorFiles: number | null;
  lastSnapshotAt: number | null;
  lastError: string | null;
}
export interface SnapshotInfo { destinationId: ID; name: string; createdAt: number; bytes: number; workspaces: number }

export interface RedactionDefaults { style: BlurStyle; strength: number }

/**
 * Appearance of one sidebar row: a folder (keyed by its path in
 * Settings.folderMeta) or a document (`WorkspaceEntry.appearance`). `logo` is
 * the file name of an uploaded image in `data/logos/`; it wins over `icon`.
 */
export interface FolderMeta { icon?: string | null; color?: string | null; logo?: string | null }

export interface Settings {
  version: 1;
  workspaces: WorkspaceEntry[];
  /** Folder paths ("CPTC", "CPTC/inject"). Every ancestor is itself stored. */
  groups: string[];
  /** Keyed by folder path; an absent key means the default look. */
  folderMeta: Record<string, FolderMeta>;
  backup: BackupSettings;
  typstCli: string | null;
  redaction: RedactionDefaults;
}

export interface DirEntry { name: string; path: string; isEmpty: boolean; isBackupRoot: boolean }
export interface DirListing { path: string; parent: string | null; entries: DirEntry[] }

export interface McpClientStatus { name: string; version: string | null; connected: boolean; lastSeenAt: number; sessions: number }
export interface McpStatus {
  endpoint: string;
  authRequired: boolean;
  clients: McpClientStatus[];
  /** Absolute path of server/mcp-stdio.ts for Claude Desktop, or null when it is not reachable from the host (container, compiled sidecar). */
  stdioBridge: string | null;
}

export interface Diagnostic { severity: 'error' | 'warning'; message: string; file: string | null; line: number | null; col: number | null }
export interface CompileResult { ok: boolean; diagnostics: Diagnostic[] }

export type ServerEvent =
  | { type: 'workspace.changed'; id: ID; paths: string[]; origin: string | null }
  | { type: 'workspaces.changed' }
  | { type: 'backup.state'; state: BackupState }
  | { type: 'mcp.clients'; clients: McpClientStatus[] };

/** One thing in the app trash (`data/trash`), as `GET /api/trash` lists it. */
export interface TrashEntry {
  /** `<stamp>/<item name>`; stable, and only ever looked up in the listing, never used as a path. */
  id: string;
  kind: 'document' | 'files';
  /** A document's name, or the file's path (or "N files") for deleted files. */
  name: string;
  /** For files: the document they were deleted from (its name in the app, else its folder name). */
  workspace: string | null;
  deletedAt: number;
  size: number;
  fileCount: number;
  canRestore: boolean;
  /** Why `canRestore` is false. */
  reason: string | null;
}

export interface TrashRestoreResult {
  id: string;
  kind: 'document' | 'files';
  /** Where it went: a document's sidebar path ("School/Lab 4"), or the document the files went back into. */
  location: string;
  /** True when the original name was taken and a "(restored)" name was used. */
  renamed: boolean;
  /** The status line the UI shows. */
  message: string;
  /** The restored document's id (document), or the document the files went into. */
  workspaceId: ID;
}
