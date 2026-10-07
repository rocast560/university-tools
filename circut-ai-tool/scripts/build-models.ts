// Converts the KiCad 3D models of the lab kit's parts into small, leg-free GLBs
// for the 3D breadboard view, plus public/models/manifest.json.
// Needs a local KiCad 9; the output is committed so nothing else does.
//
//   bun run models
//
// Env overrides: KICAD_CLI, KICAD_FOOTPRINT_DIR, KICAD_3DMODEL_DIR.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Document, Logger, NodeIO, type Material, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { clearNodeTransform, dequantize, flatten, getBounds, join, prune, quantize, reorder, transformMesh, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import {
  applyFrame, chooseFrame, type Frame, isLegMaterial, KIT_MODELS, type Manifest, type ModelInfo, type ModelKey, validateManifest,
} from '../src/models/manifest.ts';

// KiCad 9's per-user install on Windows; the env overrides cover anywhere else.
const KICAD = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'KiCad', '9.0');
const KICAD_CLI = process.env.KICAD_CLI ?? `${KICAD}/bin/kicad-cli.exe`;
const KICAD_FOOTPRINT_DIR = process.env.KICAD_FOOTPRINT_DIR ?? `${KICAD}/share/kicad/footprints`;
const KICAD_3DMODEL_DIR = process.env.KICAD_3DMODEL_DIR ?? `${KICAD}/share/kicad/3dmodels`;

const app = path.resolve(import.meta.dirname, '..');
const outDir = path.join(app, 'public', 'models');

/** Leg metal reaches below the board's top surface (y = 0) through the holes; bodies sit on it. */
const BELOW_BOARD = -1.0;
/** Leg primitives closer than this (x/z, mm) belong to the same pin. */
const CLUSTER = 0.8;
/** Same tolerance chooseFrame uses: a leg cluster must sit this close to a pad. */
const PAD_TOL = 0.3;

type XZ = [number, number];
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 + 0; // + 0 turns -0 into 0
const r3 = (x: number): number => Math.round(x * 1e3) / 1e3 + 0;

/** 1. Every named pad's position in mm relative to the footprint origin, as [x, z] with z = KiCad y. */
export function padsOf(kicadModText: string): Record<string, XZ> {
  const pads: Record<string, XZ> = {};
  const re = /\(pad\s+"([^"]*)"[\s\S]*?\(at\s+(-?[\d.]+)\s+(-?[\d.]+)/g;
  for (const m of kicadModText.matchAll(re)) {
    const [, name, x, y] = m;
    if (!name || Object.hasOwn(pads, name)) continue; // unnamed mechanical pads; duplicates keep the first
    pads[name] = [r4(Number(x)), r4(Number(y))];
  }
  return pads;
}

function footprintFile(footprint: string): string {
  const [lib, name] = footprint.split(':');
  if (!lib || !name) throw new Error(`bad footprint id "${footprint}"`);
  return path.join(KICAD_FOOTPRINT_DIR, `${lib}.pretty`, `${name}.kicad_mod`);
}

const board = (fp: string): string => `(kicad_pcb (version 20241229) (generator "benchmate-models") (generator_version "9.0")
 (general (thickness 1.6)) (paper "A4")
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user) (5 "F.SilkS" user) (1 "F.Mask" user) (3 "B.Mask" user) (31 "F.CrtYd" user) (35 "F.Fab" user) (7 "B.SilkS" user) (33 "B.CrtYd" user) (37 "B.Fab" user))
 (setup (pad_to_mask_clearance 0)) (net 0 "")
 ${fp})`;

/** 2. Export one footprint's 3D model as GLB via a scratch board; returns the GLB path. */
export function exportGlb(footprint: string, scratch: string): string {
  const text = fs.readFileSync(footprintFile(footprint), 'utf8')
    .replaceAll('${KICAD9_3DMODEL_DIR}', KICAD_3DMODEL_DIR.replaceAll('\\', '/'));
  let placed = false;
  const fp = text.replace(/^\s*\(footprint\s+"[^"]*"/, (m) => { placed = true; return `${m} (layer "F.Cu") (at 100 100)`; });
  if (!placed) throw new Error(`${footprint}: no (footprint "…") header`);
  const base = path.join(scratch, footprint.replace(/[^\w.-]+/g, '_'));
  fs.writeFileSync(`${base}.kicad_pcb`, board(fp));
  const glb = `${base}.glb`;
  const r = spawnSync(KICAD_CLI, ['pcb', 'export', 'glb', '--no-board-body', '--user-origin', '100x100mm', '-f', '-o', glb, `${base}.kicad_pcb`], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(glb)) {
    throw new Error(`kicad-cli failed for ${footprint} (exit ${r.status}): ${r.error?.message ?? ''}\n${r.stdout}\n${r.stderr}`);
  }
  return glb;
}

function positions(p: Primitive): Array<[number, number, number]> {
  const a = p.getAttribute('POSITION');
  if (!a) return [];
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < a.getCount(); i++) out.push(a.getElement(i, [0, 0, 0]) as [number, number, number]);
  return out;
}

/** Single-linkage clusters of the below-board parts of a material's primitives; centre = x/z bbox centre. */
function legClusters(prims: Primitive[]): XZ[] {
  const boxes: Array<{ lo: XZ; hi: XZ }> = [];
  for (const p of prims) {
    const below = positions(p).filter((v) => v[1] < BELOW_BOARD);
    if (!below.length) continue;
    boxes.push({
      lo: [Math.min(...below.map((v) => v[0])), Math.min(...below.map((v) => v[2]))],
      hi: [Math.max(...below.map((v) => v[0])), Math.max(...below.map((v) => v[2]))],
    });
  }
  const centre = (b: { lo: XZ; hi: XZ }): XZ => [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2];
  const clusters: Array<{ lo: XZ; hi: XZ; members: XZ[] }> = [];
  for (const b of boxes) {
    const c = centre(b);
    const hits = clusters.filter((k) => k.members.some((m) => Math.hypot(m[0] - c[0], m[1] - c[1]) <= CLUSTER));
    const merged = { lo: [...b.lo] as XZ, hi: [...b.hi] as XZ, members: [c] };
    for (const h of hits) {
      merged.lo = [Math.min(merged.lo[0], h.lo[0]), Math.min(merged.lo[1], h.lo[1])];
      merged.hi = [Math.max(merged.hi[0], h.hi[0]), Math.max(merged.hi[1], h.hi[1])];
      merged.members.push(...h.members);
      clusters.splice(clusters.indexOf(h), 1);
    }
    clusters.push(merged);
  }
  return clusters.map((k) => [r3(centre(k)[0]), r3(centre(k)[1])]);
}

function nearestPad(p: XZ, expected: Record<string, XZ>): [string, number] {
  let best = '', d = Infinity;
  for (const [name, e] of Object.entries(expected)) {
    const dd = Math.hypot(p[0] - e[0], p[1] - e[1]);
    if (dd < d) { best = name; d = dd; }
  }
  return [best, d];
}

export interface MaterialReport { name: string; color: [number, number, number]; metallic: number; colourRuleLeg: boolean; ruleLeg: boolean; clusters: number; stripped: boolean }
export interface BuildReport { key: ModelKey; footprint: string; frame: Frame; found: Record<string, XZ>; materials: MaterialReport[]; info: ModelInfo; bytes: number }

/**
 * Leg materials: isLegMaterial says metal AND the material's primitives reach through the board
 * in clusters that all sit on pads. KiCad exports metallicFactor 1 for every material, so the
 * pad test is what keeps light body parts (display case, switch actuators) out of the legs.
 */
function pickLegsAndFrame(doc: Document, expected: Record<string, XZ>, footprint: string) {
  const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
  const byMat = new Map<Material, Primitive[]>();
  for (const p of prims) {
    const m = p.getMaterial();
    if (!m) throw new Error(`${footprint}: primitive without material`);
    byMat.set(m, [...(byMat.get(m) ?? []), p]);
  }
  const mats = [...byMat.entries()].map(([m, ps]) => {
    const [r, g, b] = m.getBaseColorFactor();
    const color: [number, number, number] = [r3(r!), r3(g!), r3(b!)];
    const metallic = m.getMetallicFactor();
    return { m, ps, color, metallic, rule: isLegMaterial({ color, metallic }), colourRule: isLegMaterial({ color }), clusters: legClusters(ps) };
  });
  const tried: string[] = [];
  for (const f of ['identity', 'flipZ', 'flipX', 'rot180'] as Frame[]) {
    const legs = mats.filter((x) => x.rule && x.clusters.length > 0
      && x.clusters.every((c) => nearestPad(applyFrame(f, c), expected)[1] <= PAD_TOL));
    const found: Record<string, XZ> = {};
    for (const c of legs.flatMap((x) => x.clusters)) found[nearestPad(applyFrame(f, c), expected)[0]] = c;
    tried.push(`${f}: found ${JSON.stringify(found)}`);
    if (!legs.length) continue;
    try {
      if (chooseFrame(found, expected) !== f) continue;
    } catch { continue; }
    const report: MaterialReport[] = mats.map((x) => ({
      name: x.m.getName(), color: x.color, metallic: x.metallic, colourRuleLeg: x.colourRule, ruleLeg: x.rule,
      clusters: x.clusters.length, stripped: legs.includes(x),
    }));
    return { frame: f, found, legPrims: legs.flatMap((x) => x.ps), report };
  }
  throw new Error(`${footprint}: no frame fits the pads.\n expected ${JSON.stringify(expected)}\n ${tried.join('\n ')}\n clusters per material: ${mats.map((x) => `${x.m.getName()} ${JSON.stringify(x.clusters)}`).join('; ')}`);
}

/** 3. Read the KiCad GLB, strip the legs, put pad 1 at the origin in the board frame, write compressed. */
export async function convert(key: ModelKey, footprint: string, glbIn: string, glbOut: string, io: NodeIO): Promise<BuildReport> {
  const raw = padsOf(fs.readFileSync(footprintFile(footprint), 'utf8'));
  const p1 = raw['1'];
  if (!p1) throw new Error(`${footprint}: no pad "1"`);
  const expected: Record<string, XZ> = Object.fromEntries(Object.entries(raw).map(([n, [x, z]]) => [n, [r4(x - p1[0]), r4(z - p1[1])]]));

  const doc = (await io.read(glbIn)).setLogger(new Logger(Logger.Verbosity.WARN));
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new Error(`${footprint}: GLB has no scene`);
  const meshNodes = root.listNodes().filter((n) => n.getMesh());
  if (!meshNodes.length) throw new Error(`${footprint}: GLB has no meshes (missing 3D model?)`);
  // KiCad places the part on the board's top copper: that node's world y is the board top. Units are metres.
  const [tx, ty, tz] = meshNodes[0]!.getWorldTranslation();
  if (Math.abs(tx!) > 1e-6 || Math.abs(tz!) > 1e-6) throw new Error(`${footprint}: footprint not at the user origin (${tx}, ${tz})`);
  const wrap = doc.createNode('mm');
  for (const child of scene.listChildren()) { scene.removeChild(child); wrap.addChild(child); }
  scene.addChild(wrap);
  // glTF from KiCad is y-up with z = KiCad y, so x/z are already the board's x/z (chooseFrame confirms).
  wrap.setScale([1000, 1000, 1000]).setTranslation([-p1[0], -ty! * 1000, -p1[1]]);
  await doc.transform(dequantize(), flatten());
  for (const n of root.listNodes()) if (n.getMesh()) clearNodeTransform(n);

  const { frame, found, legPrims, report } = pickLegsAndFrame(doc, expected, footprint);
  const sx = frame === 'flipX' || frame === 'rot180' ? -1 : 1;
  const sz = frame === 'flipZ' || frame === 'rot180' ? -1 : 1;
  // transformMesh reverses triangle winding itself when the matrix has a negative determinant (one axis negated).
  if (frame !== 'identity') for (const m of root.listMeshes()) transformMesh(m, [sx, 0, 0, 0, 0, 1, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]);

  for (const p of legPrims) p.dispose();
  await doc.transform(join(), weld(), prune());
  const b = getBounds(scene);
  const box = { min: b.min.map(r3) as [number, number, number], max: b.max.map(r3) as [number, number, number] };

  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await doc.transform(reorder({ encoder: MeshoptEncoder }), quantize());
  await io.write(glbOut, doc);

  const info: ModelInfo = { file: path.basename(glbOut), footprint, pads: expected, box };
  return { key, footprint, frame, found, materials: report, info, bytes: fs.statSync(glbOut).size };
}

/** 4 + 5. Build every kit model into a temp dir; only move into public/models when all succeed. */
async function main(): Promise<void> {
  for (const [what, p] of [['KICAD_CLI', KICAD_CLI], ['KICAD_FOOTPRINT_DIR', KICAD_FOOTPRINT_DIR], ['KICAD_3DMODEL_DIR', KICAD_3DMODEL_DIR]] as const) {
    if (!fs.existsSync(p)) throw new Error(`${what} not found: ${p}`);
  }
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmate-models-'));
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(outDir), '.models-build-'));
  try {
    const manifest: Manifest = { version: 1, models: {} };
    const reports: BuildReport[] = [];
    for (const [key, { footprint }] of Object.entries(KIT_MODELS) as Array<[ModelKey, { footprint: string }]>) {
      const glb = exportGlb(footprint, scratch);
      const rep = await convert(key, footprint, glb, path.join(staging, `${key}.glb`), io);
      manifest.models[key] = rep.info;
      reports.push(rep);
    }
    validateManifest(JSON.parse(JSON.stringify(manifest)));
    fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    fs.mkdirSync(outDir, { recursive: true });
    const fresh = new Set(fs.readdirSync(staging));
    for (const f of fs.readdirSync(outDir)) {
      if ((f.endsWith('.glb') || f === 'manifest.json') && !fresh.has(f)) fs.rmSync(path.join(outDir, f));
    }
    for (const f of fresh) fs.renameSync(path.join(staging, f), path.join(outDir, f));

    for (const r of reports) {
      console.log(`${r.key} (${r.footprint}): ${r.bytes} B, frame ${r.frame}, box ${JSON.stringify(r.info.box)}`);
      console.log(`  pads ${JSON.stringify(r.info.pads)}`);
      console.log(`  found ${JSON.stringify(r.found)}`);
      for (const m of r.materials) {
        console.log(`  ${m.name} rgb ${JSON.stringify(m.color)} metallic ${m.metallic} isLegMaterial ${m.ruleLeg} (colour only ${m.colourRuleLeg}) below-board clusters ${m.clusters} -> ${m.stripped ? 'STRIPPED' : 'kept'}`);
      }
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(`build-models: nothing written.\n${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
