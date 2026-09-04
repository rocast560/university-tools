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
}
export interface WorkspaceStatus extends WorkspaceEntry { status: 'ok' | 'missing' }
export interface FileEntry { path: string; size: number; mtime: number }
export interface WorkspaceDetail {
  entry: WorkspaceEntry;
  files: FileEntry[];
  meta: WorkspaceJson;
  assets: TypstAsset[];
  folders: AssetFolder[];
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
export interface Settings {
  version: 1;
  workspaces: WorkspaceEntry[];
  groups: string[];
  backup: BackupSettings;
  typstCli: string | null;
  redaction: RedactionDefaults;
}

export interface DirEntry { name: string; path: string; isEmpty: boolean; isBackupRoot: boolean }
export interface DirListing { path: string; parent: string | null; entries: DirEntry[] }

export interface McpClientStatus { name: string; version: string | null; connected: boolean; lastSeenAt: number; sessions: number }
export interface McpStatus { endpoint: string; authRequired: boolean; clients: McpClientStatus[] }

export interface Diagnostic { severity: 'error' | 'warning'; message: string; file: string | null; line: number | null; col: number | null }
export interface CompileResult { ok: boolean; diagnostics: Diagnostic[] }

export type ServerEvent =
  | { type: 'workspace.changed'; id: ID; paths: string[]; origin: string | null }
  | { type: 'workspaces.changed' }
  | { type: 'backup.state'; state: BackupState }
  | { type: 'mcp.clients'; clients: McpClientStatus[] };
