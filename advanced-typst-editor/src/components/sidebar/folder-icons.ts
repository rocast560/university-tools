// The folder appearance roster: ten theme-aware colours and forty icons.
//
// The icon map is explicit rather than a dynamic `lucide-react` lookup so a
// typo is a typecheck failure instead of a blank square, and so the bundler
// can see exactly which icons to include. Stored values are these keys, never
// component references.

import {
  Archive, Atom, Beaker, Binary, Book, BookOpen, Bug, Calculator, Camera, CircuitBoard,
  ClipboardList, Code, Cpu, Database, FileText, FlaskConical, Flag, Folder, FolderOpen,
  GraduationCap, Hammer, Image, Key, Lock, Microscope, Network, NotebookPen, Palette, Pi,
  Presentation, Rocket, Ruler, Server, Shield, Sigma, Star, Target, Terminal, Wrench, Zap,
  type LucideIcon,
} from 'lucide-react';

export const FOLDER_COLORS = [
  'slate', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'purple', 'indigo',
] as const;
export type FolderColor = (typeof FOLDER_COLORS)[number];

/** A CSS colour for a stored colour name, or null for the default tint. */
export function folderColorVar(color: string | null | undefined): string | null {
  return color && (FOLDER_COLORS as readonly string[]).includes(color) ? `hsl(var(--folder-${color}))` : null;
}

const ICONS = {
  folder: Folder, 'folder-open': FolderOpen, book: Book, 'book-open': BookOpen,
  'graduation-cap': GraduationCap, 'flask-conical': FlaskConical, beaker: Beaker,
  microscope: Microscope, atom: Atom, cpu: Cpu, 'circuit-board': CircuitBoard,
  binary: Binary, network: Network, server: Server, database: Database,
  terminal: Terminal, code: Code, bug: Bug, shield: Shield, lock: Lock, key: Key,
  zap: Zap, wrench: Wrench, hammer: Hammer, ruler: Ruler, calculator: Calculator,
  sigma: Sigma, pi: Pi, 'file-text': FileText, 'notebook-pen': NotebookPen,
  'clipboard-list': ClipboardList, presentation: Presentation, image: Image,
  camera: Camera, palette: Palette, rocket: Rocket, target: Target, flag: Flag,
  star: Star, archive: Archive,
} satisfies Record<string, LucideIcon>;

export const FOLDER_ICON_NAMES = Object.keys(ICONS) as ReadonlyArray<keyof typeof ICONS>;

/** The icon for a stored name; anything unknown renders as a plain folder. */
export function folderIcon(name: string | null | undefined): LucideIcon {
  return (name && (ICONS as Record<string, LucideIcon>)[name]) || Folder;
}
