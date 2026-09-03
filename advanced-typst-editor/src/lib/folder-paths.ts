/**
 * BTCT's asset panel thinks in folder records (id, parentId, name). Here a
 * folder id IS its path relative to assets/, so these map panel intentions
 * to API paths.
 */
export function folderPathFor(parentId: string | null, name: string): string {
  const clean = name.trim().replace(/[\\/]/g, '_');
  return parentId ? `${parentId}/${clean}` : clean;
}
export function renamedFolderPath(id: string, name: string): string {
  const parent = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : null;
  return folderPathFor(parent, name);
}
export function movedFolderPath(id: string, parentId: string | null): string {
  const base = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return folderPathFor(parentId, base);
}
