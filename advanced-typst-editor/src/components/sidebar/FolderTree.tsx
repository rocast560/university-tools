import { FolderRow } from '@/components/sidebar/FolderRow';
import { WorkspaceRow } from '@/components/sidebar/WorkspaceRow';
import { docKey } from '@/lib/collapsed-groups';
import { childPaths } from '@/lib/folder-tree';
import type { DragPayload, DropTarget } from '@/lib/sidebar-dnd';
import type { ClickMods } from '@/lib/sidebar-selection';
import type { Nesting } from '@/lib/workspace-nesting';
import { subtreeCount } from '@/lib/workspace-groups';
import type { WorkspaceStatus, FolderMeta } from '@/types';

export interface FolderTreeProps {
  parent: string | null;
  depth: number;
  groups: string[];
  folderMeta: Record<string, FolderMeta>;
  byFolder: Map<string, WorkspaceStatus[]>;
  /** Which documents sit under which; only top-level documents are listed straight from `byFolder`. */
  nesting: Nesting<WorkspaceStatus>;
  /** Collapsed folder paths and collapsed documents (`docKey`). */
  collapsed: Set<string>;
  activeId: string | null;
  selectedIds: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onSelect: (id: string, mods: ClickMods) => void;
  onFolderMenu: (path: string, x: number, y: number) => void;
  onWorkspaceMenu: (ws: WorkspaceStatus, x: number, y: number) => void;
  /** The folder path, or `docKey(id)` of a document row, that a legal drag is hovering. */
  dropTarget: string | null;
  onDragStart: (p: DragPayload) => void;
  onDragOver: (e: React.DragEvent, path: string) => void;
  onDragLeave: (path: string) => void;
  onRowDragOver: (e: React.DragEvent, id: string) => void;
  onRowDragLeave: (id: string) => void;
  /** A folder path, null for the top level, or `{ workspace }` when the drop lands on a document row. */
  onDrop: (e: React.DragEvent, target: DropTarget) => void;
}

/**
 * One level of the sidebar: this folder's subfolders first (A-Z), then the
 * top-level documents filed directly in it (most recently opened first), each
 * followed by the documents nested under it.
 */
export function FolderTree(props: FolderTreeProps) {
  const { parent, depth, groups, folderMeta, byFolder, collapsed, activeId, nesting } = props;

  /** A document row, then its children one level in, unless it is collapsed. `seen` stops a cycle in bad data. */
  const renderDoc = (ws: WorkspaceStatus, level: number, seen: ReadonlySet<string>): React.ReactNode => {
    const kids = (nesting.childrenOf.get(ws.id) ?? []).filter((k) => !seen.has(k.id));
    const isCollapsed = collapsed.has(docKey(ws.id));
    const next = new Set(seen).add(ws.id);
    return (
      <div key={ws.id}>
        <WorkspaceRow
          ws={ws}
          active={ws.id === activeId}
          selected={props.selectedIds.has(ws.id)}
          indent={level}
          nest={kids.length ? { collapsed: isCollapsed } : undefined}
          dropActive={props.dropTarget === docKey(ws.id)}
          onSelect={props.onSelect}
          onMenu={props.onWorkspaceMenu}
          onToggleChildren={(id) => props.onToggle(docKey(id))}
          onDragStart={props.onDragStart}
          onDragOver={props.onRowDragOver}
          onDragLeave={props.onRowDragLeave}
          onDrop={props.onDrop}
        />
        {!isCollapsed && kids.map((k) => renderDoc(k, level + 1, next))}
      </div>
    );
  };

  return (
    <>
      {childPaths(groups, parent).map((path) => {
        const isCollapsed = collapsed.has(path);
        return (
          <div key={path}>
            <FolderRow
              path={path}
              meta={folderMeta[path]}
              collapsed={isCollapsed}
              count={subtreeCount(byFolder, path)}
              indent={depth}
              dropActive={props.dropTarget === path}
              onToggle={props.onToggle}
              onMenu={props.onFolderMenu}
              onDragStart={props.onDragStart}
              onDragOver={props.onDragOver}
              onDragLeave={props.onDragLeave}
              onDrop={props.onDrop}
            />
            {!isCollapsed && <FolderTree {...props} parent={path} depth={depth + 1} />}
          </div>
        );
      })}
      {(byFolder.get(parent ?? '') ?? []).filter((ws) => nesting.isRoot(ws)).map((ws) => renderDoc(ws, depth, new Set()))}
    </>
  );
}
