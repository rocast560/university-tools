import { FolderRow } from '@/components/sidebar/FolderRow';
import { WorkspaceRow } from '@/components/sidebar/WorkspaceRow';
import { childPaths } from '@/lib/folder-tree';
import type { DragPayload } from '@/lib/sidebar-dnd';
import { subtreeCount } from '@/lib/workspace-groups';
import type { WorkspaceStatus, FolderMeta } from '@/types';

export interface FolderTreeProps {
  parent: string | null;
  depth: number;
  groups: string[];
  folderMeta: Record<string, FolderMeta>;
  byFolder: Map<string, WorkspaceStatus[]>;
  collapsed: Set<string>;
  activeId: string | null;
  onToggle: (path: string) => void;
  onSelect: (id: string) => void;
  onFolderMenu: (path: string, x: number, y: number) => void;
  onWorkspaceMenu: (ws: WorkspaceStatus, x: number, y: number) => void;
  dropTarget: string | null;
  onDragStart: (p: DragPayload) => void;
  onDragOver: (e: React.DragEvent, path: string) => void;
  onDragLeave: (path: string) => void;
  /** `path` is null when the drop lands on a top-level workspace row. */
  onDrop: (e: React.DragEvent, path: string | null) => void;
}

/**
 * One level of the sidebar: this folder's subfolders first (A-Z), then the
 * workspaces filed directly in it (most recently opened first).
 */
export function FolderTree(props: FolderTreeProps) {
  const { parent, depth, groups, folderMeta, byFolder, collapsed, activeId } = props;
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
      {(byFolder.get(parent ?? '') ?? []).map((ws) => (
        <WorkspaceRow
          key={ws.id}
          ws={ws}
          active={ws.id === activeId}
          indent={depth}
          folder={parent}
          onSelect={props.onSelect}
          onMenu={props.onWorkspaceMenu}
          onDragStart={props.onDragStart}
          onDrop={props.onDrop}
        />
      ))}
    </>
  );
}
