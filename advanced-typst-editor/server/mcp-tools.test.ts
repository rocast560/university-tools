import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createEventBus } from './events';
import { createSettingsStore } from './settings';
import { createWorkspaceService } from './service';
import { createCompiler } from './compile';
import { createBackup } from './backup/index';
import { TOOLS, callTool, type ToolDeps } from './mcp-tools';
import { tmpDir, rmDir, put, TYPST_CLI } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function setup(): ToolDeps & { dataDir: string } {
  const dataDir = tmpDir(); dirs.push(dataDir);
  const bus = createEventBus();
  const settings = createSettingsStore(dataDir);
  const workspacesDir = path.join(dataDir, 'workspaces');
  const service = createWorkspaceService({ settings, bus, watcher: null, dataDir, workspacesDir, template: '#let image-placeholder(caption, path: none, height: 2.2in) = figure(caption: caption)[x]\n= T\n' });
  const compile = createCompiler({ settings, service, typstCli: fs.existsSync(TYPST_CLI) ? TYPST_CLI : null });
  const backup = createBackup({ settings, service, bus, dataDir, workspacesDir, version: '0.1.0' });
  return { service, compile, backup, settings, dataDir };
}
const call = (deps: ToolDeps, name: string, args: Record<string, unknown> = {}) => callTool(name, args, deps);

describe('MCP tools', () => {
  it('exposes exactly the 27 tools from the spec', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      'add_font', 'add_slot', 'backup_status', 'clear_slot', 'compile', 'create_workspace', 'delete_asset', 'delete_workspace',
      'edit_source', 'export_pdf', 'get_source', 'get_workspace', 'list_assets', 'list_slots', 'list_snapshots', 'list_workspaces',
      'move_asset', 'move_workspace', 'open_workspace_folder', 'place_image', 'rename_asset', 'rename_workspace', 'run_backup',
      'set_slot_height', 'set_source', 'update_asset', 'upload_asset',
    ]);
    for (const t of TOOLS) expect(t.description.length).toBeGreaterThan(20);
  });

  it('workspace lifecycle and source editing', async () => {
    const d = setup();
    const w = await call(d, 'create_workspace', { name: 'Rep', group: 'G' }) as { id: string; slots: unknown[] };
    expect((await call(d, 'list_workspaces') as unknown[]).length).toBe(1);
    expect(await call(d, 'get_source', { workspace_id: w.id })).toMatchObject({ file: 'main.typ', source: expect.stringContaining('= T') });
    await call(d, 'set_source', { workspace_id: w.id, source: '= A\nhello world\nhello' });
    await expect(call(d, 'edit_source', { workspace_id: w.id, old_string: 'hello', new_string: 'bye' })).rejects.toThrow(/2 times/);
    expect(await call(d, 'edit_source', { workspace_id: w.id, old_string: 'hello', new_string: 'bye', replace_all: true })).toMatchObject({ replacements: 2 });
    expect(await call(d, 'rename_workspace', { workspace_id: w.id, name: 'Rep2' })).toMatchObject({ name: 'Rep2' });
    expect(await call(d, 'move_workspace', { workspace_id: w.id, group: null })).toMatchObject({ group: null });
    const ext = tmpDir(); dirs.push(ext); put(ext, 'main.typ', '= ext');
    expect(await call(d, 'open_workspace_folder', { path: ext })).toMatchObject({ library: false });
    expect(await call(d, 'delete_workspace', { workspace_id: w.id })).toEqual({ ok: true });
    expect(fs.existsSync(path.join(d.dataDir, 'trash'))).toBe(true);
  });

  it('figure slots and assets', async () => {
    const d = setup();
    const w = await call(d, 'create_workspace', { name: 'R' }) as { id: string };
    expect(await call(d, 'add_slot', { workspace_id: w.id, caption: 'Proof' })).toMatchObject({ slot: { caption: 'Proof' }, slotCount: 1 });
    const up = await call(d, 'upload_asset', { workspace_id: w.id, filename: 'shot.jpg', data_base64: PNG_B64, folder: 'f' }) as { id: string };
    expect(up.id).toBe('assets/f/shot.png');
    const placed = await call(d, 'place_image', { workspace_id: w.id, slot_index: 0, asset_id: up.id, height: '3in' }) as { slots: Array<{ path: string | null; heightPt: number | null }> };
    expect(placed.slots[0]).toMatchObject({ path: '/assets/f/shot.png', heightPt: 216 });
    expect((await call(d, 'list_slots', { workspace_id: w.id }) as unknown[]).length).toBe(1);
    await call(d, 'set_slot_height', { workspace_id: w.id, slot_index: 0, height: '2in' });
    expect(await call(d, 'rename_asset', { workspace_id: w.id, asset_id: up.id, stem: 'proof' })).toMatchObject({ references: 1, asset: { id: 'assets/f/proof.png' } });
    expect(await call(d, 'move_asset', { workspace_id: w.id, asset_id: 'assets/f/proof.png', folder: null })).toMatchObject({ asset: { id: 'assets/proof.png' } });
    expect(await call(d, 'update_asset', { workspace_id: w.id, asset_id: 'assets/proof.png', blurs: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] })).toMatchObject({ blurs: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] });
    await call(d, 'clear_slot', { workspace_id: w.id, slot_index: 0 });
    expect((await call(d, 'list_assets', { workspace_id: w.id }) as unknown[]).length).toBe(1);
    const fontPath = 'C:/Users/rober/Desktop/typst-editor/recovered-from-docker/fonts/DejaVuSansMono.ttf';
    expect(await call(d, 'add_font', { workspace_id: w.id, path: fontPath })).toMatchObject({ id: 'fonts/DejaVuSansMono.ttf', fontFamily: 'DejaVu Sans Mono' });
    expect(await call(d, 'delete_asset', { workspace_id: w.id, asset_id: 'assets/proof.png' })).toEqual({ ok: true });
    const ws = await call(d, 'get_workspace', { workspace_id: w.id }) as { assets: unknown[]; slots: unknown[]; files: unknown[] };
    expect(ws.assets).toHaveLength(1);
    expect(ws.slots).toHaveLength(1);
  });

  it("add_font probes the family using the source file's own extension, not a filename override", async () => {
    const d = setup();
    const w = await call(d, 'create_workspace', { name: 'R' }) as { id: string };
    const fontPath = 'C:/Users/rober/Desktop/typst-editor/recovered-from-docker/fonts/DejaVuSansMono.ttf';
    // filename claims a different (but still allowed) font extension; R11 says
    // the probe must use the extension of the real source file (`path`'s
    // basename), not this override, or a typst-CLI probe would misdetect it.
    const added = await call(d, 'add_font', { workspace_id: w.id, path: fontPath, filename: 'weird-name.woff2' }) as { id: string; fontFamily: string | null };
    expect(added).toMatchObject({ id: 'fonts/weird-name.woff2', fontFamily: 'DejaVu Sans Mono' });
  });

  it('backup tools and compile', async () => {
    const d = setup();
    const dest = tmpDir(); dirs.push(dest);
    d.backup.configure({ destinations: [{ path: dest, mirror: true, snapshots: true }] });
    const w = await call(d, 'create_workspace', { name: 'R', source: '= ok' }) as { id: string };
    expect(await call(d, 'backup_status')).toMatchObject({ destinations: [{ path: path.resolve(dest) }] });
    const ran = await call(d, 'run_backup') as { lastSnapshotAt: number; destinations: Array<{ id: string }> };
    expect(ran.lastSnapshotAt).toBeTruthy();
    expect((await call(d, 'list_snapshots', { destination_id: ran.destinations[0]!.id }) as unknown[]).length).toBe(1);
    if (fs.existsSync(TYPST_CLI)) {
      expect(await call(d, 'compile', { workspace_id: w.id })).toMatchObject({ ok: true });
      const out = path.join(dest, 'r.pdf');
      expect(await call(d, 'export_pdf', { workspace_id: w.id, to: out })).toMatchObject({ path: out, baked: 0 });
    }
  });
});
