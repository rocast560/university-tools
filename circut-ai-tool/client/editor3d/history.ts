// Undo and redo for the 3D editor, after three.js editor's History.js: one
// command per finished gesture, each able to run and to undo itself. Commands
// carry model data (a ref and its holes before and after), never scene
// objects, so they survive the scene being rebuilt under them.
//
// Only layout changes go on this stack. Schematic edits keep the server's
// backups instead; replaying them from here would race the file watcher.

export interface Command {
  label: string;
  /** Do it; false when the server refused, and then nothing is recorded. */
  run(): Promise<boolean>;
  undo(): Promise<boolean>;
}

export class History {
  private undos: Command[] = [];
  private redos: Command[] = [];
  private fns = new Set<() => void>();

  get canUndo() {
    return this.undos.length > 0;
  }
  get canRedo() {
    return this.redos.length > 0;
  }

  onChange(fn: () => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  private changed() {
    for (const fn of this.fns) fn();
  }

  async execute(cmd: Command): Promise<boolean> {
    if (!(await cmd.run())) return false;
    this.undos.push(cmd);
    this.redos = [];
    this.changed();
    return true;
  }

  async undo(): Promise<boolean> {
    const cmd = this.undos.pop();
    if (!cmd) return false;
    if (!(await cmd.undo())) {
      this.undos.push(cmd);
      return false;
    }
    this.redos.push(cmd);
    this.changed();
    return true;
  }

  async redo(): Promise<boolean> {
    const cmd = this.redos.pop();
    if (!cmd) return false;
    if (!(await cmd.run())) {
      this.redos.push(cmd);
      return false;
    }
    this.undos.push(cmd);
    this.changed();
    return true;
  }

  clear() {
    this.undos = [];
    this.redos = [];
    this.changed();
  }
}

export const history = new History();
