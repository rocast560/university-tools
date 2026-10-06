// Which board tool holds the pointer: an armed tray part or the wire tool.
// Only one may; a tool that takes over tells the others to stand down.

export type Tool = 'tray' | 'wire';

const listeners = new Set<(tool: Tool) => void>();

/** `tool` is starting: every other tool's listener hears it and stands down. */
export function claimTool(tool: Tool) {
  for (const fn of [...listeners]) fn(tool);
}

/** Hear another tool take over; returns the disposer. */
export function onToolClaimed(fn: (tool: Tool) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
