import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectRegistry, sidecarPath } from '../server/projects.ts';
import { Service, ServiceError, type ProjectEvent } from '../server/service.ts';
import { Events } from '../server/watch.ts';
import { fakeKicad } from './fake-kicad.ts';
import { FIXTURES, readFixture } from './smoke.test.ts';

export async function makeService(opts: { watch?: boolean } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), 'svc-'));
  const sch = path.join(work, 'PL1_1.kicad_sch');
  copyFileSync(path.join(FIXTURES, 'PL1_1.kicad_sch'), sch);
  const registry = new ProjectRegistry(path.join(work, 'data'));
  await registry.load();
  const events = new Events<ProjectEvent>();
  const service = new Service({ kicad: fakeKicad(readFixture('PL1_1.net')), registry, events, watch: opts.watch ?? false, projectsDir: work, libs: { symbolText: async (id) => { throw new Error(`no lib ${id}`); } } });
  return { service, sch, events, work };
}

describe('Service', () => {
  test('opens a schematic by path, then by id, and lists it', async () => {
    const { service, sch } = await makeService();
    const p = await service.open(sch);
    expect(p.info.name).toBe('PL1_1');
    expect(p.doc.error).toBeNull();
    expect(p.doc.checks.filter((c) => c.level === 'error')).toEqual([]);
    expect(service.get(p.info.id).info.id).toBe(p.info.id);
    const again = await service.open(p.info.id);
    expect(again.info.id).toBe(p.info.id);
    const list = await service.list();
    expect(list.recent[0].id).toBe(p.info.id);
    expect(list.found.map((f) => f.name)).toEqual(['PL1_1']);
  });

  test('rejects missing files, wrong extensions, sheets and buses', async () => {
    const { service, work } = await makeService();
    await expect(service.open(path.join(work, 'nope.kicad_sch'))).rejects.toThrow(/not found/);
    writeFileSync(path.join(work, 'x.txt'), 'x');
    await expect(service.open(path.join(work, 'x.txt'))).rejects.toThrow(/\.kicad_sch/);
    const withSheet = path.join(work, 'sheet.kicad_sch');
    writeFileSync(withSheet, '(kicad_sch (version 20250114) (generator "eeschema") (uuid "u") (paper "A4") (lib_symbols) (sheet (at 0 0) (size 10 10) (uuid "s")))');
    await expect(service.open(withSheet)).rejects.toThrow(/hierarchical sheets/);
    const withBus = path.join(work, 'bus.kicad_sch');
    writeFileSync(withBus, '(kicad_sch (version 20250114) (generator "eeschema") (uuid "u") (paper "A4") (lib_symbols) (bus (pts (xy 0 0) (xy 1 1)) (uuid "b")))');
    await expect(service.open(withBus)).rejects.toThrow(/buses/);
    expect(() => service.get('nope')).toThrow(ServiceError);
  });

  test('movePart persists to the sidecar and the layout follows', async () => {
    const { service, sch } = await makeService();
    const p = await service.open(sch);
    const d2 = p.doc.pinHoles.D2;
    const target = { '1': { col: d2['1'].col + 3, row: d2['1'].row }, '2': { col: d2['2'].col + 3, row: d2['2'].row } };
    const moved = await service.movePart(p.info.id, 'D2', target);
    expect(moved.doc.pinHoles.D2).toEqual(target);
    expect(JSON.parse(readFileSync(sidecarPath(sch), 'utf8')).pinned.D2).toEqual(target);
    await expect(service.movePart(p.info.id, 'D2', { '1': { col: 1, row: 'a' } })).rejects.toThrow(/pin 2/);
    await expect(service.movePart(p.info.id, 'D2', { '1': { col: 5, row: 'T+' }, '2': { col: 6, row: 'T+' } })).rejects.toThrow(/dropped|taken/);
    const reset = await service.resetLayout(p.info.id);
    expect(reset.sidecar.pinned).toEqual({});
  });

  test('options, colours and simulation', async () => {
    const { service, sch } = await makeService();
    const p = await service.open(sch);
    const withDip = await service.setOptions(p.info.id, { dipSwitchPositions: 4 });
    expect(withDip.doc.packages[0].kind).toBe('dipswitch');
    const coloured = await service.setColor(p.info.id, '/A', '#123456');
    expect(coloured.doc.nets['/A'].color).toBe('#123456');
    await expect(service.setColor(p.info.id, '/A', 'red')).rejects.toThrow(/#rrggbb/);
    const back = await service.setColor(p.info.id, '/A', null);
    expect(back.doc.nets['/A'].color).not.toBe('#123456');
    const sim = service.simulate(p.info.id, { '/A': 1, '/B': 0 });
    expect(sim.nets['/Y1']).toBe(1);
    expect(await service.schematicSvg(p.info.id)).toContain('<svg');
  });

  test('refresh re-reads the file and the watcher emits events', async () => {
    const { service, sch, events } = await makeService({ watch: true });
    const p = await service.open(sch);
    const got: ProjectEvent[] = [];
    events.subscribe((e) => got.push(e));
    const text = readFileSync(sch, 'utf8');
    writeFileSync(sch, text);
    const t = new Date(Date.now() + 2000);
    utimesSync(sch, t, t);
    await new Promise((r) => setTimeout(r, 900));
    expect(got.some((e) => e.projectId === p.info.id && e.type === 'changed')).toBe(true);
    const r = await service.refresh(p.info.id);
    expect(r.mtimeMs).toBeGreaterThan(0);
    service.close(p.info.id);
    expect(service.has(p.info.id)).toBe(false);
  });
});
