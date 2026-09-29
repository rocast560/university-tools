// The home page's project shelves: folders you make, projects you drag into
// them, and an Unfiled shelf for everything else. Recent and library projects
// are one list here, with a badge on the ones that have been opened.

import { api, type Organizer, type ProjectLists } from './api.ts';
import { esc, h, toast } from './main.ts';

interface Item {
  path: string;
  name: string;
  id?: string;
  lastOpened?: string;
}

const DRAG_TYPE = 'application/x-circuit-project';

/** Recent and found projects as one list, by path, most recently opened first. */
function items(lists: ProjectLists): Item[] {
  const byPath = new Map<string, Item>();
  for (const p of lists.found) byPath.set(p.path, { path: p.path, name: p.name });
  for (const p of lists.recent) byPath.set(p.path, { ...byPath.get(p.path), path: p.path, name: p.name, id: p.id, lastOpened: p.lastOpened });
  return [...byPath.values()].sort((a, b) => (b.lastOpened ?? '').localeCompare(a.lastOpened ?? '') || a.name.localeCompare(b.name));
}

const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

export async function mountOrganizer(root: HTMLElement, lists: ProjectLists) {
  let org: Organizer = { folders: [], placements: {} };
  try {
    org = await api.organizer();
  } catch (err) {
    toast(`Folders unavailable: ${(err as Error).message}`);
  }
  const all = items(lists);

  const open = async (path: string) => {
    try {
      const s = await api.open(path);
      location.hash = `#/p/${s.id}`;
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const itemHtml = (p: Item) =>
    `<li class="org-item" draggable="true" data-path="${esc(p.path)}" title="drag to a folder">
      <span class="grip" aria-hidden="true">⠿</span>
      <a href="#/" data-open="${esc(p.path)}"><b>${esc(p.name)}</b><span>${esc(p.path)}</span></a>
      ${p.lastOpened ? `<em class="badge">opened ${esc(ago(p.lastOpened))}</em>` : '<em class="badge muted">library</em>'}
    </li>`;

  const shelf = (id: string | null, name: string, list: Item[], editable: boolean) =>
    `<section class="org-shelf ${id ? '' : 'is-unfiled'}" data-folder="${id ?? ''}">
      <h3>
        <span class="org-name">${esc(name)}</span><span class="count">${list.length}</span>
        ${editable ? `<span class="org-actions"><button type="button" class="btn ghost" data-rename title="rename">Rename</button><button type="button" class="btn ghost" data-delete title="delete this folder; its projects go back to Unfiled">Delete</button></span>` : ''}
      </h3>
      <ul class="projects org-items">${list.map(itemHtml).join('') || `<li class="muted org-empty">${id ? 'drop projects here' : 'nothing here'}</li>`}</ul>
    </section>`;

  const paint = () => {
    const inFolder = (fid: string) => all.filter((p) => org.placements[p.path] === fid);
    const unfiled = all.filter((p) => !org.folders.some((f) => f.id === org.placements[p.path]));
    root.innerHTML =
      `<div class="org-bar"><button type="button" class="btn" data-new-folder>New folder</button><span class="muted">Drag a project onto a folder. Folders are saved on the server.</span></div>` +
      org.folders.map((f) => shelf(f.id, f.name, inFolder(f.id), true)).join('') +
      shelf(null, 'Unfiled', unfiled, false);
  };
  paint();

  /** Swap a shelf's name for an input; Enter saves, Escape cancels. */
  const editName = (shelfEl: HTMLElement, current: string, onDone: (name: string) => Promise<void>) => {
    const nameEl = shelfEl.querySelector<HTMLElement>('.org-name')!;
    const input = h(`<input class="org-edit" value="${esc(current)}" maxlength="60">`) as HTMLInputElement;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== current) {
        try {
          await onDone(name);
        } catch (err) {
          toast((err as Error).message);
        }
      }
      paint();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void finish(true);
      if (e.key === 'Escape') void finish(false);
    });
    input.addEventListener('blur', () => void finish(true));
  };

  root.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLAnchorElement>('a[data-open]');
    if (a) {
      e.preventDefault();
      return open(a.dataset.open!);
    }
    if (t.closest('[data-new-folder]')) {
      // An inline shelf that becomes real once it has a name.
      const draft = h(shelf('draft', 'New folder', [], false));
      root.querySelector('.org-bar')!.after(draft);
      editName(draft, 'New folder', async (name) => {
        org.folders.push(await api.createFolder(name));
      });
      return;
    }
    const shelfEl = t.closest<HTMLElement>('.org-shelf');
    const fid = shelfEl?.dataset.folder;
    if (!shelfEl || !fid) return;
    if (t.closest('[data-rename]')) {
      const f = org.folders.find((x) => x.id === fid)!;
      editName(shelfEl, f.name, async (name) => {
        f.name = (await api.renameFolder(fid, name)).name;
      });
    } else if (t.closest('[data-delete]')) {
      try {
        await api.deleteFolder(fid);
        org.folders = org.folders.filter((x) => x.id !== fid);
        for (const [p, id] of Object.entries(org.placements)) if (id === fid) delete org.placements[p];
        paint();
      } catch (err) {
        toast((err as Error).message);
      }
    }
  });

  // Drag a project between shelves. The type is ours, so the file dropzone
  // above ignores these and the browser's own file drags ignore the shelves.
  root.addEventListener('dragstart', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('.org-item');
    if (!li || !e.dataTransfer) return;
    e.dataTransfer.setData(DRAG_TYPE, li.dataset.path!);
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('is-dragging');
  });
  root.addEventListener('dragend', (e) => {
    (e.target as HTMLElement).closest('.org-item')?.classList.remove('is-dragging');
    root.querySelectorAll('.is-over').forEach((el) => el.classList.remove('is-over'));
  });
  root.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    const shelfEl = (e.target as HTMLElement).closest<HTMLElement>('.org-shelf');
    if (!shelfEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    root.querySelectorAll('.is-over').forEach((el) => el !== shelfEl && el.classList.remove('is-over'));
    shelfEl.classList.add('is-over');
  });
  root.addEventListener('dragleave', (e) => {
    const shelfEl = (e.target as HTMLElement).closest<HTMLElement>('.org-shelf');
    if (shelfEl && !shelfEl.contains(e.relatedTarget as Node | null)) shelfEl.classList.remove('is-over');
  });
  root.addEventListener('drop', async (e) => {
    const path = e.dataTransfer?.getData(DRAG_TYPE);
    const shelfEl = (e.target as HTMLElement).closest<HTMLElement>('.org-shelf');
    if (!path || !shelfEl) return;
    e.preventDefault();
    const fid = shelfEl.dataset.folder || null;
    try {
      await api.moveProject(path, fid);
      if (fid) org.placements[path] = fid;
      else delete org.placements[path];
      paint();
    } catch (err) {
      toast((err as Error).message);
    }
  });
}
