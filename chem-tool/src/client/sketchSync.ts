/** Whether the sketcher must be reset to the incoming molecule. Our own pushes never reset it. */
export function shouldResetEditor(actor: string | null, ownWindowId: string, editorIdCode: string | null, incomingIdCode: string): boolean {
  if (actor === `window:${ownWindowId}`) return false;
  if (editorIdCode === incomingIdCode) return false;
  return true;
}
