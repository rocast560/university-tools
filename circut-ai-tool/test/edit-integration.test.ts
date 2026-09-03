import { describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KICAD_CLI, KICAD_SYMBOL_DIR } from '../server/config.ts';
import { createKicadCli } from '../server/kicad-cli.ts';
import { createLibraryLookup } from '../server/libraries.ts';
import { ProjectRegistry } from '../server/projects.ts';
import { Service, type ProjectEvent } from '../server/service.ts';
import { Events } from '../server/watch.ts';
import { FIXTURES } from './smoke.test.ts';

const have = existsSync(KICAD_CLI) && existsSync(path.join(KICAD_SYMBOL_DIR, 'Device.kicad_sym'));

export async function realService() {
  const work = mkdtempSync(path.join(tmpdir(), 'edit-'));
  const sch = path.join(work, 'PL1_1.kicad_sch');
  copyFileSync(path.join(FIXTURES, 'PL1_1.kicad_sch'), sch);
  const registry = new ProjectRegistry(path.join(work, 'data'));
  await registry.load();
  const service = new Service({ kicad: createKicadCli({ exe: KICAD_CLI, cacheDir: path.join(work, 'cache') }), registry, events: new Events<ProjectEvent>(), watch: false, projectsDir: work, libs: createLibraryLookup({ symbolDir: KICAD_SYMBOL_DIR, projectDir: work }) });
  return { service, sch, work };
}

describe.skipIf(!have)('edits verified through kicad-cli', () => {
  test('add an LED with connections, then remove it', async () => {
    const { service, sch, work } = await realService();
    const p = await service.open(sch);
    const out = await service.addComponent(p.info.id, { libId: 'Device:LED', value: 'LED', connections: { '1': 'Y1', '2': '+5V' } });
    expect(out.ref).toBe('D3');
    expect(existsSync(out.backup)).toBe(true);
    expect(readdirSync(path.join(work, '.circuit-ai-backups')).length).toBe(1);
    const d3 = out.project.design.components.get('D3')!;
    expect(d3.pins.get('1')!.net).toBe('/Y1');
    expect(d3.pins.get('2')!.net).toBe('+5V');
    expect(out.project.doc.pinHoles.D3).toBeDefined();
    expect(out.notes.join(' ')).toMatch(/File > Revert/);
    const rm = await service.removeComponent(p.info.id, 'D3');
    expect(rm.project.design.components.has('D3')).toBe(false);
    expect(rm.project.design.nets.get('/Y1')!.some((m) => m.ref === 'D3')).toBe(false);
  }, 60000);

  test('labels land on pins at every rotation and mirror', async () => {
    const { service, work } = await realService();
    const lib = (await createLibraryLookup({ symbolDir: KICAD_SYMBOL_DIR }).symbolText('Device:R')).replace(/^\(symbol/, '(symbol');
    const sym = (ref: string, x: number, y: number, rot: number, mirror: string | null) => `(symbol (lib_id "Device:R") (at ${x} ${y} ${rot}) ${mirror ? `(mirror ${mirror}) ` : ''}(unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "${crypto.randomUUID()}") (property "Reference" "${ref}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)))) (property "Value" "1k" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)))) (pin "1" (uuid "${crypto.randomUUID()}")) (pin "2" (uuid "${crypto.randomUUID()}")) (instances (project "rot" (path "/11111111-1111-1111-1111-111111111111" (reference "${ref}") (unit 1)))))`;
    const text = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "11111111-1111-1111-1111-111111111111") (paper "A4") (lib_symbols ${lib}) ${sym('R1', 50, 50, 0, null)} ${sym('R2', 80, 50, 90, null)} ${sym('R3', 110, 50, 180, null)} ${sym('R4', 140, 50, 270, null)} ${sym('R5', 170, 50, 0, 'x')} ${sym('R6', 200, 50, 90, 'y')} (sheet_instances (path "/" (page "1"))))`;
    const file = path.join(work, 'rot.kicad_sch');
    writeFileSync(file, text);
    const p = await service.open(file);
    for (const ref of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
      await service.connect(p.info.id, ref, '1', `TOP${ref}`);
      await service.connect(p.info.id, ref, '2', `BOT${ref}`);
    }
    const final = service.get(p.info.id);
    for (const ref of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
      expect(final.design.components.get(ref)!.pins.get('1')!.net).toBe(`/TOP${ref}`);
      expect(final.design.components.get(ref)!.pins.get('2')!.net).toBe(`/BOT${ref}`);
    }
  }, 120000);

  test('a stale file is refused', async () => {
    const { service, sch } = await realService();
    const p = await service.open(sch);
    writeFileSync(sch, p.schematic.text + '\n');
    await expect(service.setValue(p.info.id, 'R1', '2k')).rejects.toThrow(/changed on disk/);
    await service.refresh(p.info.id);
    const out = await service.setValue(p.info.id, 'R1', '2k');
    expect(out.project.design.components.get('R1')!.value).toBe('2k');
  }, 60000);
});
