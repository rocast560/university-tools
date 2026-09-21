import { FolderRow } from '@/components/sidebar/FolderRow';
import { WorkspaceRow } from '@/components/sidebar/WorkspaceRow';
import { childPaths } from '@/lib/folder-tree';
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
  onDrop: (e: React.DragEvent, path: string) => void;
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
              onToggle={props.onToggle}
              onMenu={props.onFolderMenu}
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
          onSelect={props.onSelect}
          onMenu={props.onWorkspaceMenu}
        />
      ))}
    </>
  );
}
