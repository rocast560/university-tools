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
  private tail: Promise<unknown> = Promise.resolve();
  // Bumped by clear(); an operation begun before it must not touch the stacks after it.
  private gen = 0;

  /** One operation at a time, in the order asked. */
  private queue<T>(f: () => Promise<T>): Promise<T> {
    const r = this.tail.then(f);
    this.tail = r.then(() => {}, () => {});
    return r;
  }

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

  execute(cmd: Command): Promise<boolean> {
    // Taken when asked, not when its turn comes: a clear() in between must cancel it.
    const g = this.gen;
    return this.queue(async () => {
      if (g !== this.gen) return false;
      if (!(await cmd.run())) return false;
      if (g !== this.gen) return true;
      this.undos.push(cmd);
      this.redos = [];
      this.changed();
      return true;
    });
  }

  undo(): Promise<boolean> {
    // Taken when asked, not when its turn comes: a clear() in between must cancel it.
    const g = this.gen;
    return this.queue(async () => {
      if (g !== this.gen) return false;
      const cmd = this.undos[this.undos.length - 1];
      if (!cmd) return false;
      if (!(await cmd.undo())) return false;
      if (g !== this.gen) return true;
      this.undos.pop();
      this.redos.push(cmd);
      this.changed();
      return true;
    });
  }

  redo(): Promise<boolean> {
    // Taken when asked, not when its turn comes: a clear() in between must cancel it.
    const g = this.gen;
    return this.queue(async () => {
      if (g !== this.gen) return false;
      const cmd = this.redos[this.redos.length - 1];
      if (!cmd) return false;
      if (!(await cmd.run())) return false;
      if (g !== this.gen) return true;
      this.redos.pop();
      this.undos.push(cmd);
      this.changed();
      return true;
    });
  }

  clear() {
    this.gen++;
    this.undos = [];
    this.redos = [];
    this.changed();
  }
}

export const history = new History();
