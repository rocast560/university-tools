// The things that sit on the 3D board: chips, DIP switches, LEDs, resistors
// and the rest, plus the shared materials they are built from. Separate from
// board3d.ts so that file stays about the board, the lighting and the loop.
//
// Everything is in the renderer's units, where one hole pitch is 18, so one
// millimetre is about 7.1. Parts are modelled at their real sizes: a 5 mm LED
// really is twice as wide as the pitch and really does tower over a DIP, and
// letting it do so is most of what makes the board read as a physical thing.
//
// Nothing here invents a position. Every leg, lead and wire end is placed from
// the hole the layout assigned it, so the 3D board cannot claim a connection
// the flat board does not have.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Hole, Package, PlacedPart } from '../src/layout/types.ts';
import type { LayoutDoc } from '../src/pipeline.ts';
import { icInfo } from '../src/parts/gates.ts';
import { ledSpec, ledSpecFor, type LedSpec } from '../src/parts/led.ts';
import { resistorBands } from '../src/parts/resistor.ts';
import { L3_BOARD, L3_SILK } from '../src/parts/lab3.ts';
import { archY, MAX_ARCH, WIRE_END_Y } from '../src/render/altitude.ts';
import { P, placeAt, ROWY, tierShift } from '../src/render/geometry.ts';
import type { BoardSpec } from '../src/layout/types.ts';
import { positionKey } from '../src/render/index.ts';

/** 1 mm in board units: one 0.1 inch pitch is 18 units. */
export const MM = P / 2.54;
/** The top face of the board. */
export const TOP = 0;
export const BOARD_THICK = 9 * MM;

/**
 * The board being built. Holes on a stacked layout land on their own board,
 * one TIER_PITCH further back per board; mount3d sets it before building.
 */
let board: BoardSpec = { cols: 63, kind: 'full', splitCol: null, railGapEvery: 6 };
export function setHoleBoard(b: BoardSpec): void {
  board = b;
}
export const holeX = (h: Hole) => placeAt(board, h)[0];
export const holeZ = (h: Hole) => placeAt(board, h)[1];
/** The z of the middle channel under a package whose pin 1 is in `col`. */
const channelZ = (col: number) => (ROWY.e + ROWY.f) / 2 + tierShift(board, col)[1];
export const at = (h: Hole, y = TOP) => new THREE.Vector3(holeX(h), y, holeZ(h));

const UP = new THREE.Vector3(0, 1, 0);
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Owns every material and geometry made for one mounted board, so the whole
 * lot is released in a single pass when the view closes.
 */
export class Kit {
  // A set, so a buffer swapped out while the board is open can leave it again.
  private readonly bin = new Set<{ dispose(): void }>();
  readonly M: Materials;

  constructor() {
    this.M = palette(this);
  }

  keep<T extends { dispose(): void }>(x: T): T {
    this.bin.add(x);
    return x;
  }

  /** Free `old` now and keep `next` in its place (a drag preview's buffers), so the kit never piles up the ones it replaced. */
  swap<T extends { dispose(): void }>(old: { dispose(): void }, next: T): T {
    old.dispose();
    this.bin.delete(old);
    return this.keep(next);
  }

  std(o: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    return this.keep(new THREE.MeshStandardMaterial(o));
  }

  phys(o: THREE.MeshPhysicalMaterialParameters): THREE.MeshPhysicalMaterial {
    return this.keep(new THREE.MeshPhysicalMaterial(o));
  }

  /** A mesh that both casts and takes shadow, which is nearly all of them. */
  mesh(g: THREE.BufferGeometry, m: THREE.Material | THREE.Material[]): THREE.Mesh {
    const mesh = new THREE.Mesh(this.keep(g), m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  dispose(): void {
    for (const x of this.bin) x.dispose();
    this.bin.clear();
  }
}

/**
 * A tiling grain, used as a roughness or bump map.
 *
 * Nothing manufactured is uniformly rough: moulded epoxy has a pebbled skin,
 * tinned wire is scuffed, a resistor's ceramic is mottled. A single roughness
 * number gives every surface the same flawless sheen, which is most of what
 * makes a render look like a render. One cheap noise map breaks that up
 * everywhere at once.
 *
 * Left in linear space deliberately: a roughness or bump map is data, not
 * colour, and tagging it sRGB would bend the values on the way in.
 */
/**
 * mulberry32: a tiny seeded PRNG. Every procedural texture draws from its own
 * fixed seed, so a rebuild after each move paints the same surface again
 * instead of visibly re-rolling the speckle.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function grain(kit: Kit, px: number, spread: number, mid = 0.5): THREE.CanvasTexture {
  const random = seededRandom(0x9e3779b9);
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(px, px);
  for (let i = 0; i < px * px; i++) {
    // Two octaves: a fine speckle over a slow drift, so the surface has both
    // a texture up close and a variation you read from across the board.
    const x = i % px;
    const y = (i / px) | 0;
    const slow = Math.sin(x * 0.19) * Math.cos(y * 0.23) * 0.5 + 0.5;
    const value = mid + (random() - 0.5) * spread + (slow - 0.5) * spread * 0.6;
    const b = Math.max(0, Math.min(255, Math.round(value * 255)));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = kit.keep(new THREE.CanvasTexture(cv));
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** The same grain, repeated at a chosen density. */
function grainAt(kit: Kit, px: number, spread: number, repeat: number, mid = 0.5): THREE.CanvasTexture {
  const tex = grain(kit, px, spread, mid);
  tex.repeat.set(repeat, repeat);
  return tex;
}

/** A grain any caller can hang on a material, for surfaces built outside here. */
export function grainMap(kit: Kit, repeat: number, spread = 0.4, mid = 0.5): THREE.CanvasTexture {
  return grainAt(kit, 128, spread, repeat, mid);
}

/**
 * The corona a bright emitter grows: a hot centre falling away to nothing.
 *
 * This is the piece that makes a lit LED look lit rather than repainted. No
 * display can show something brighter than white, so brightness past that point
 * has to be spent on area instead - which is exactly what an eye and a camera
 * lens do with a light source. One gradient, tinted per LED, drawn additively
 * so it can only ever add light to what is behind it.
 *
 * Shared across every LED on the board, and released with the kit that made it.
 */
const coronas = new WeakMap<Kit, THREE.CanvasTexture>();
function corona(kit: Kit): THREE.CanvasTexture {
  const cached = coronas.get(kit);
  if (cached) return cached;
  const px = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const g = cv.getContext('2d')!;
  const c = px / 2;
  const grd = g.createRadialGradient(c, c, 0, c, c, c);
  // Steep in the middle, long in the tail: a narrow blown-out core with a wide
  // faint glow is what a real one looks like, and an even falloff reads as fog.
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.1, 'rgba(255,255,255,0.78)');
  grd.addColorStop(0.26, 'rgba(255,255,255,0.26)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.06)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, px, px);
  const tex = kit.keep(new THREE.CanvasTexture(cv));
  tex.colorSpace = THREE.SRGBColorSpace;
  coronas.set(kit, tex);
  return tex;
}

/**
 * A resistor's ceramic: a beige body with the cloudy mottling a real one has
 * where the coating went on thicker in some places than others.
 */
function ceramic(kit: Kit): THREE.CanvasTexture {
  const px = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#e3cfa0';
  g.fillRect(0, 0, px, px);
  const random = seededRandom(0x85ebca6b);
  for (let i = 0; i < 900; i++) {
    const a = random() * 0.09;
    g.fillStyle = random() > 0.5 ? `rgba(150,126,80,${a})` : `rgba(255,246,220,${a})`;
    const r = 2 + random() * 9;
    g.beginPath();
    g.arc(random() * px, random() * px, r, 0, Math.PI * 2);
    g.fill();
  }
  const tex = kit.keep(new THREE.CanvasTexture(cv));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function palette(kit: Kit) {
  // Shared maps. One texture serving many materials costs one upload, and the
  // repeat is chosen per material by cloning only where it has to differ.
  const fine = grainAt(kit, 128, 0.34, 5, 0.52);
  const coarse = grainAt(kit, 128, 0.5, 2.5, 0.5);
  const metal = grainAt(kit, 128, 0.42, 7, 0.42);

  return {
    board: kit.std({ color: '#e6e0cf', roughness: 0.78, metalness: 0.02, roughnessMap: coarse }),
    // Real boards have a peel-off adhesive backing, which is what you see
    // from below.
    backing: kit.std({ color: '#d8cdb4', roughness: 0.95, metalness: 0, roughnessMap: coarse }),
    channel: kit.std({ color: '#cfc8b4', roughness: 0.88, roughnessMap: coarse }),
    socket: kit.std({ color: '#15181c', roughness: 0.7, roughnessMap: fine }),
    /** Tinned copper: component leads and stripped wire ends. */
    tin: kit.std({ color: '#c3c9d2', roughness: 0.26, metalness: 0.95, roughnessMap: metal }),
    /** The duller nickel of a DIP leg. */
    leg: kit.std({ color: '#aab1bb', roughness: 0.35, metalness: 0.9, roughnessMap: metal }),
    /** Moulded epoxy of a chip package, pebbled the way the mould leaves it. */
    epoxy: kit.std({ color: '#26282e', roughness: 0.48, metalness: 0.04, roughnessMap: fine, bumpMap: fine, bumpScale: 0.5 }),
    body: kit.std({ color: '#ffffff', map: ceramic(kit), roughness: 0.62, roughnessMap: fine, bumpMap: fine, bumpScale: 0.22 }),
    /** The glossier blue lacquer of a metal-film resistor. */
    bodyMetal: kit.std({ color: '#3f7fcf', roughness: 0.4, roughnessMap: fine, bumpMap: fine, bumpScale: 0.12 }),
    dark: kit.std({ color: '#2a2d33', roughness: 0.55, roughnessMap: fine }),
    glass: kit.std({ color: '#14141a', roughness: 0.18, metalness: 0.1 }),
    dipCase: kit.std({ color: '#b4232c', roughness: 0.44, roughnessMap: fine, bumpMap: fine, bumpScale: 0.35 }),
    dipWell: kit.std({ color: '#efe6d3', roughness: 0.68, roughnessMap: fine }),
    dipSlider: kit.std({ color: '#25282e', roughness: 0.5, roughnessMap: fine, bumpMap: fine, bumpScale: 0.3 }),
  };
}

export type Materials = {
  board: THREE.MeshStandardMaterial;
  backing: THREE.MeshStandardMaterial;
  channel: THREE.MeshStandardMaterial;
  socket: THREE.MeshStandardMaterial;
  tin: THREE.MeshStandardMaterial;
  leg: THREE.MeshStandardMaterial;
  epoxy: THREE.MeshStandardMaterial;
  body: THREE.MeshStandardMaterial;
  bodyMetal: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  dipCase: THREE.MeshStandardMaterial;
  dipWell: THREE.MeshStandardMaterial;
  dipSlider: THREE.MeshStandardMaterial;
};

// ---------- small geometry helpers ----------

/**
 * Compose a matrix that stretches a unit box so it spans a to b, `w` wide and
 * `t` thick. One InstancedMesh of unit boxes can then draw a whole chip's
 * legs, whichever direction each bend runs in.
 */
function spanMatrix(m: THREE.Matrix4, a: THREE.Vector3, b: THREE.Vector3, w: number, t: number): THREE.Matrix4 {
  const dir = b.clone().sub(a);
  const len = dir.length() || 1;
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.divideScalar(len));
  return m.compose(a.clone().add(b).multiplyScalar(0.5), q, v3(w, len, t));
}

/** A cylinder running from a to b: leads, wire cores, resistor bands. */
export function tube(kit: Kit, a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material, seg = 10): THREE.Mesh {
  const len = a.distanceTo(b) || 0.01;
  const mesh = kit.mesh(new THREE.CylinderGeometry(r, r, len, seg), m);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
  return mesh;
}

/** A disc with one chord sliced off it, the way a 5 mm LED's flange is. */
function dFlange(r: number, flat: number, h: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const half = Math.acos(Math.min(flat / r, 0.999));
  shape.absarc(0, 0, r, half, Math.PI * 2 - half, false);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: true, bevelSize: 0.5, bevelThickness: 0.5, bevelSegments: 2, curveSegments: 32 });
  // Extrusion runs along +z; stand it up so it runs along +y, flat facing +x.
  g.rotateX(-Math.PI / 2);
  return g;
}

// ---------- printed markings ----------

/**
 * A part's printed face, drawn once into a transparent canvas and laid over
 * it. Text is far cheaper and far crisper as a texture than as geometry, and
 * a chip you cannot read is a chip you have to count pins on.
 */
function marking(kit: Kit, lengthUnits: number, depthUnits: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const scale = 8;
  const cv = document.createElement('canvas');
  cv.width = Math.max(2, Math.round(lengthUnits * scale));
  cv.height = Math.max(2, Math.round(depthUnits * scale));
  const g = cv.getContext('2d')!;
  g.scale(scale, scale);
  draw(g, lengthUnits, depthUnits);
  const tex = kit.keep(new THREE.CanvasTexture(cv));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * The plane a marking is painted on, lying just above a package's top face.
 * A plane turned a quarter back puts the image's top edge at -z, which is the
 * row e side of the board.
 */
function markingPlane(kit: Kit, tex: THREE.Texture, length: number, depth: number, x: number, y: number, z: number): THREE.Mesh {
  const mat = kit.std({ map: tex, transparent: true, roughness: 0.62, metalness: 0, depthWrite: false });
  const plane = new THREE.Mesh(kit.keep(new THREE.PlaneGeometry(length, depth)), mat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(x, y, z);
  return plane;
}

/** What a chip's back should say: the part number, and what the part does. */
export function chipLegend(pkg: Package, doc: LayoutDoc): { code: string; description: string } {
  const code = doc.values[pkg.id] ?? pkg.name;
  const info = icInfo(code, pkg.pins);
  // "quad 2-input NAND", and for the decoders the clause before the comma,
  // which is the part anyone actually reads.
  return { code, description: info?.spec?.description.split(',')[0] ?? '' };
}

// ---------- packages: chips and DIP switches ----------

/** A DIP body is narrower than its pin rows, which is what shows the legs. */
const BODY_HALF_Z = 13;
/** Half the width of a DIP switch case, scaled from 9.8 mm against the 7.62 mm its rows stand for here. */
const DIP_SWITCH_HALF_Z = 23;
const BODY_LIFT = 1.2;
const BODY_H = 3.6 * MM;

/** One flickable way of a DIP switch: what to move, and where the ends are. */
export interface Way {
  key: string;
  slider: THREE.Object3D;
  onZ: number;
  offZ: number;
}

export interface BuiltPackage {
  object: THREE.Object3D;
  /** Empty for a chip; one entry per way of a DIP switch. */
  ways: Way[];
  /** What a jumper has to clear to pass over this package. */
  top: number;
  /** The footprint jumpers must fly over, when it is not the usual chip across the gutter. */
  obstacle?: Obstacle;
  /** Set for a seven-segment display, so the running simulation can light its digit. */
  display?: SevenSegLamp;
}

/**
 * One package, built from the holes the layout actually assigned to its pins
 * rather than from a formula, so a pin can only be drawn where the flat board
 * and the build guide already say it is.
 */
export function buildPackage(kit: Kit, pkg: Package, doc: LayoutDoc): BuiltPackage {
  if (pkg.kind === 'module') return buildModule(kit, pkg, doc);
  if (pkg.kind === 'sevenseg') return buildSevenSeg(kit, pkg, doc);
  const group = new THREE.Group();
  const pins = Object.entries(doc.pinHoles[pkg.id] ?? {});
  if (!pins.length) return { object: group, ways: [], top: TOP };
  const xs = pins.map(([, h]) => holeX(h));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const dip = pkg.kind === 'dipswitch';
  // A DIP switch case is wider than its pin rows (9.8 mm over 7.62) and runs
  // about 2.3 mm past the end ways; a chip's epoxy sits inside its rows.
  const halfZ = dip ? DIP_SWITCH_HALF_Z : BODY_HALF_Z;
  const length = x1 - x0 + (dip ? 32 : 15);
  const cx = (x0 + x1) / 2;
  const cz = channelZ(pkg.col0);
  const yBottom = TOP + BODY_LIFT;
  const yTop = yBottom + BODY_H;

  const body = kit.mesh(new RoundedBoxGeometry(length, BODY_H, halfZ * 2, 3, 1.4), dip ? kit.M.dipCase : kit.M.epoxy);
  body.position.set(cx, (yBottom + yTop) / 2, cz);
  group.add(body);

  const ways: Way[] = [];
  if (dip) for (const o of dipSwitchTop(kit, pkg, x0, x1, cz, yTop, ways)) group.add(o);
  else group.add(markingPlane(kit, chipMarking(kit, pkg, doc, length), length, BODY_HALF_Z * 2, cx, yTop + 0.15, cz));

  // Legs: out of the body side, angled down, then straight into the socket.
  const legs = kit.keep(new THREE.InstancedMesh(kit.keep(new THREE.BoxGeometry(1, 1, 1)), kit.M.leg, pins.length * 2));
  legs.castShadow = true;
  const m4 = new THREE.Matrix4();
  pins.forEach(([, hole], i) => {
    const x = holeX(hole);
    const z = holeZ(hole);
    const side = Math.sign(z - cz) || 1;
    const shoulder = v3(x, yBottom + BODY_H * 0.42, cz + side * halfZ);
    const knee = v3(x, yBottom + BODY_H * 0.08, z);
    legs.setMatrixAt(i * 2, spanMatrix(m4, shoulder, knee, 3.4, 2));
    legs.setMatrixAt(i * 2 + 1, spanMatrix(m4, knee, v3(x, TOP - 5, z), 3.4, 2));
  });
  legs.instanceMatrix.needsUpdate = true;
  group.add(legs);
  return { object: group, ways, top: yTop + (dip ? 3 : 0.5) };
}

/**
 * The L3 auxiliary board at its measured size (see L3_BOARD): a blue PCB on a
 * male header that stands it a header's height above the breadboard, gold
 * pads and silkscreen beside each header position, and the wide DIP socket
 * with the potted chip filling the rest. The body hangs outward from its
 * header row, over the rails and off the edge, exactly as the flat board draws it.
 */
function buildModule(kit: Kit, pkg: Package, doc: LayoutDoc): BuiltPackage {
  const group = new THREE.Group();
  const holes = Object.entries(doc.pinHoles[pkg.id] ?? {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, h]) => h);
  if (!holes.length) return { object: group, ways: [], top: TOP };
  const xs = holes.map(holeX);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const zh = holeZ(holes[0]);
  const dir = (pkg.row ?? holes[0].row) === 'j' ? 1 : -1;
  const length = x1 - x0 + 2 * L3_BOARD.endMargin * P;
  const depth = (L3_BOARD.inset + L3_BOARD.depth) * P;
  const cx = (x0 + x1) / 2;
  const zNear = zh - dir * L3_BOARD.inset * P;
  const zFar = zh + dir * L3_BOARD.depth * P;
  const cz = (zNear + zFar) / 2;
  const HEADER_H = 2.5 * MM;
  const PCB_T = 1.6 * MM;
  const pcbBottom = TOP + HEADER_H;
  const pcbTop = pcbBottom + PCB_T;
  const m4 = new THREE.Matrix4();

  const pcb = kit.mesh(new RoundedBoxGeometry(length, PCB_T, depth, 2, 0.8), kit.std({ color: '#1f3a66', roughness: 0.55, metalness: 0.05 }));
  pcb.position.set(cx, (pcbBottom + pcbTop) / 2, cz);
  group.add(pcb);

  // The header: its plastic strip under the board, and a square pin per
  // position running from the breadboard socket up through its pad.
  const strip = kit.mesh(new THREE.BoxGeometry(x1 - x0 + P, HEADER_H, 2.54 * MM), kit.M.epoxy);
  strip.position.set(cx, TOP + HEADER_H / 2, zh);
  group.add(strip);
  const pinTop = pcbTop + 1.5 * MM;
  const pins = kit.keep(new THREE.InstancedMesh(kit.keep(new THREE.BoxGeometry(0.64 * MM, 1, 0.64 * MM)), kit.M.leg, holes.length));
  pins.castShadow = true;
  const pads = kit.keep(new THREE.InstancedMesh(kit.keep(new THREE.CylinderGeometry(0.95 * MM, 0.95 * MM, 0.08 * MM, 18)), kit.std({ color: '#c7a544', roughness: 0.32, metalness: 0.85 }), holes.length));
  holes.forEach((h, i) => {
    const x = holeX(h);
    pins.setMatrixAt(i, m4.makeTranslation(x, (TOP - 5 + pinTop) / 2, zh).scale(new THREE.Vector3(1, pinTop - (TOP - 5), 1)));
    pads.setMatrixAt(i, m4.makeTranslation(x, pcbTop + 0.04 * MM, zh));
  });
  pins.instanceMatrix.needsUpdate = true;
  pads.instanceMatrix.needsUpdate = true;
  group.add(pins, pads);

  // Silkscreen: the label beside each position, the separator at position 7
  // and the board name along the far edge.
  group.add(markingPlane(kit, moduleSilk(kit, pkg, length, depth, dir), length, depth, cx, pcbTop + 0.1, cz));

  // The wide DIP socket, then the chip seated in it with its legend.
  const sNear = zh + dir * L3_BOARD.socket.near * P;
  const sFar = zh + dir * L3_BOARD.socket.far * P;
  const SOCKET_H = 4 * MM;
  const socket = kit.mesh(new THREE.BoxGeometry(x1 - x0 + P, SOCKET_H, Math.abs(sFar - sNear) + 0.6 * P), kit.M.socket);
  socket.position.set(cx, pcbTop + SOCKET_H / 2, (sNear + sFar) / 2);
  group.add(socket);
  const chipLen = x1 - x0 + 0.6 * P;
  const chipDepth = Math.abs(sFar - sNear) - 0.6 * P;
  const chipBottom = pcbTop + SOCKET_H - 0.5 * MM;
  const chipTop = chipBottom + BODY_H;
  const chip = kit.mesh(new RoundedBoxGeometry(chipLen, BODY_H, chipDepth, 3, 1.4), kit.M.epoxy);
  chip.position.set(cx, (chipBottom + chipTop) / 2, (sNear + sFar) / 2);
  group.add(chip);
  group.add(markingPlane(kit, moduleChipMarking(kit, chipLen, chipDepth), chipLen, chipDepth, cx, chipTop + 0.15, (sNear + sFar) / 2));

  const obstacle: Obstacle = { x0: cx - length / 2, x1: cx + length / 2, z0: Math.min(zNear, zFar), z1: Math.max(zNear, zFar), top: chipTop };
  return { object: group, ways: [], top: chipTop + 0.5, obstacle };
}

/** The L3 board's silkscreen. The image's top edge lands at -z, so a board hanging upward (dir -1) has its header at the bottom of the image. */
function moduleSilk(kit: Kit, pkg: Package, length: number, depth: number, dir: -1 | 1): THREE.CanvasTexture {
  return marking(kit, length, depth, (g, w, h) => {
    const yHeader = dir === -1 ? h - L3_BOARD.inset * P : L3_BOARD.inset * P;
    const yFar = dir === -1 ? 6 : h - 6;
    const xFirst = L3_BOARD.endMargin * P;
    g.fillStyle = '#f4f6fa';
    g.strokeStyle = '#f4f6fa';
    g.lineWidth = 1.2;
    g.textBaseline = 'middle';
    for (let i = 0; i < pkg.pins; i++) {
      const x = xFirst + i * P;
      const label = L3_SILK[i];
      if (!label) {
        g.beginPath();
        g.moveTo(x, yHeader - dir * 6);
        g.lineTo(x, yHeader - dir * 24);
        g.stroke();
        continue;
      }
      g.save();
      g.translate(x, yHeader - dir * 8);
      g.rotate(dir === -1 ? -Math.PI / 2 : Math.PI / 2);
      g.textAlign = 'left';
      g.font = `700 7px ui-monospace, Consolas, monospace`;
      g.fillText(label, 0, 0);
      g.restore();
    }
    g.textAlign = 'center';
    g.font = `600 7px ui-monospace, Consolas, monospace`;
    g.fillText(`${pkg.id}  L3 AUXILIARY`, w / 2, yFar);
  });
}

/** The potted chip's legend, read along its long axis, with a pin 1 dimple. */
function moduleChipMarking(kit: Kit, length: number, depth: number): THREE.CanvasTexture {
  return marking(kit, length, depth, (g, w, h) => {
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.beginPath();
    g.arc(h * 0.18, h * 0.8, h * 0.07, 0, Math.PI * 2);
    g.fill();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#d5d9e1';
    g.font = `700 ${(h * 0.28).toFixed(1)}px ui-monospace, Consolas, monospace`;
    g.fillText('L3 CKT', w / 2, h / 2);
  });
}

/** One seven-segment display, so the running board can light its digit. */
export interface SevenSegLamp {
  /** Segment letter -> the material of that bar; the decimal point is 'dp'. */
  segments: Record<string, THREE.MeshStandardMaterial>;
}

/** Real outline of a 0.39 inch single-digit display such as the SA39-11EWA, in mm. */
const SEG_BODY = { width: 12.7, depth: 19.0, height: 7.2, digitW: 6.2, digitH: 10.0, bar: 1.3 };

/**
 * A single-digit seven-segment display at its real size: a grey epoxy block
 * 12.7 by 19 mm standing 7 mm tall across the gutter, a dark red window on
 * top, and seven bars plus a decimal point that glow when the simulator
 * drives them. The digit is upright with the decimal point on the row f side,
 * which is how the flat board and the build guide orient it.
 */
function buildSevenSeg(kit: Kit, pkg: Package, doc: LayoutDoc): BuiltPackage {
  const group = new THREE.Group();
  const holes = Object.entries(doc.pinHoles[pkg.id] ?? {}).map(([, h]) => h);
  if (!holes.length) return { object: group, ways: [], top: TOP };
  const xs = holes.map(holeX);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cz = channelZ(pkg.col0);
  const width = SEG_BODY.width * MM;
  const depth = SEG_BODY.depth * MM;
  const height = SEG_BODY.height * MM;
  // A display stands a few millimetres above the board on its pins, which is
  // what lets you see where each one goes in.
  const yBottom = TOP + 2.5 * MM;
  const yTop = yBottom + height;

  const body = kit.mesh(new RoundedBoxGeometry(width, height, depth, 3, 1.2), kit.std({ color: '#8d8f94', roughness: 0.6, metalness: 0.02 }));
  body.position.set(cx, (yBottom + yTop) / 2, cz);
  group.add(body);
  // The tinted window the segments sit under.
  const win = kit.mesh(new THREE.BoxGeometry(width - 1.2 * MM, 0.3 * MM, depth - 1.2 * MM), kit.std({ color: '#2a0d0d', roughness: 0.25, metalness: 0.05 }));
  win.position.set(cx, yTop + 0.15 * MM, cz);
  group.add(win);

  // Segment bars: a top, b upper right, c lower right, d bottom, e lower left,
  // f upper left, g middle; dp at the lower right. x runs across the board,
  // z down it, so the digit's top (segment a) faces the top rails.
  const w = SEG_BODY.digitW * MM;
  const h = SEG_BODY.digitH * MM;
  const t = SEG_BODY.bar * MM;
  const bars: Record<string, [number, number, number, number]> = {
    a: [0, -h / 2, w - t, t],
    g: [0, 0, w - t, t],
    d: [0, h / 2, w - t, t],
    b: [w / 2, -h / 4, t, h / 2 - t],
    c: [w / 2, h / 4, t, h / 2 - t],
    e: [-w / 2, h / 4, t, h / 2 - t],
    f: [-w / 2, -h / 4, t, h / 2 - t],
    dp: [w / 2 + t * 1.4, h / 2, t, t],
  };
  const segments: Record<string, THREE.MeshStandardMaterial> = {};
  for (const [seg, [dx, dz, bw, bd]] of Object.entries(bars)) {
    const mat = kit.std({ color: '#3b1414', emissive: '#ff3b1f', emissiveIntensity: 0, roughness: 0.5 });
    const bar = kit.mesh(new THREE.BoxGeometry(bw, 0.25 * MM, bd), mat);
    bar.position.set(cx + dx, yTop + 0.4 * MM, cz + dz);
    group.add(bar);
    segments[seg] = mat;
  }

  // Legs straight down from the body into the sockets.
  const pins = Object.entries(doc.pinHoles[pkg.id] ?? {});
  const legs = kit.keep(new THREE.InstancedMesh(kit.keep(new THREE.BoxGeometry(0.5 * MM, 1, 0.5 * MM)), kit.M.leg, holes.length));
  legs.castShadow = true;
  const m4 = new THREE.Matrix4();
  holes.forEach((hole, i) => legs.setMatrixAt(i, spanMatrix(m4, v3(holeX(hole), yBottom + 1, holeZ(hole)), v3(holeX(hole), TOP - 5, holeZ(hole)), 3.4, 2)));
  legs.instanceMatrix.needsUpdate = true;
  group.add(legs);

  // Pin numbers printed along the bottom of each long side, above the pins
  // they name, and a pin 1 mark at the corner it sits under.
  const near = pins.filter(([, h]) => holeZ(h) > cz);
  const far = pins.filter(([, h]) => holeZ(h) <= cz);
  const label = (facing: 1 | -1, list: [string, Hole][]) => {
    const tex = marking(kit, width, height, (g, w, h) => {
      g.fillStyle = '#f2f3f5';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `700 ${(h * 0.24).toFixed(1)}px ui-monospace, Consolas, monospace`;
      for (const [num, hole] of list) {
        const lx = facing === 1 ? holeX(hole) - cx : cx - holeX(hole);
        g.fillText(num, w / 2 + lx, h * 0.8);
      }
      g.font = `${(h * 0.18).toFixed(1)}px ui-monospace, Consolas, monospace`;
      g.fillText(`${pkg.id} ${pkg.name}`, w / 2, h * 0.3);
    });
    const plane = new THREE.Mesh(kit.keep(new THREE.PlaneGeometry(width, height)), kit.std({ map: tex, transparent: true, roughness: 0.6, depthWrite: false }));
    plane.position.set(cx, (yBottom + yTop) / 2, cz + facing * (depth / 2 + 0.3));
    if (facing === -1) plane.rotation.y = Math.PI;
    return plane;
  };
  group.add(label(1, near), label(-1, far));

  const obstacle: Obstacle = { x0: cx - width / 2, x1: cx + width / 2, z0: cz - depth / 2, z1: cz + depth / 2, top: yTop + 1 };
  return { object: group, ways: [], top: yTop + 1, obstacle, display: { segments } };
}

/** The ivory wells and their actuators, recessed into the red case. */
function dipSwitchTop(kit: Kit, pkg: Package, x0: number, x1: number, cz: number, yTop: number, ways: Way[]): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const count = pkg.positions ?? pkg.pins / 2;
  const wellDepth = DIP_SWITCH_HALF_Z * 1.2;
  for (let i = 0; i < count; i++) {
    const x = x0 + ((x1 - x0) * i) / Math.max(1, count - 1);
    const key = positionKey(pkg, i + 1);
    // The whole way is one pickable object, so a click anywhere on it flips
    // that way and only that way, exactly as on the flat board.
    const way = new THREE.Group();
    way.userData.switchKey = key;
    const well = kit.mesh(new THREE.BoxGeometry(P * 0.62, 2.4, wellDepth), kit.M.dipWell);
    well.position.set(x, yTop - 0.9, cz);
    way.add(well);
    // Off is the end away from the ON legend, matching the flat board.
    const offZ = cz + wellDepth / 4;
    const onZ = cz - wellDepth / 4;
    const slider = kit.mesh(new RoundedBoxGeometry(P * 0.44, 2.8, wellDepth / 2 - 1.5, 2, 0.6), kit.M.dipSlider);
    slider.position.set(x, yTop + 0.6, offZ);
    way.add(slider);
    out.push(way);
    ways.push({ key, slider, onZ, offZ });
  }
  const length = x1 - x0 + 32;
  out.push(markingPlane(kit, dipMarking(kit, count, length), length, DIP_SWITCH_HALF_Z * 2, (x0 + x1) / 2, yTop + 0.25, cz));
  return out;
}

function chipMarking(kit: Kit, pkg: Package, doc: LayoutDoc, length: number): THREE.CanvasTexture {
  const { code, description } = chipLegend(pkg, doc);
  const tex = marking(kit, length, BODY_HALF_Z * 2, (g, w, h) => {
    // The moulded half-round notch at the pin 1 end and the pin 1 dimple.
    // Both are shape rather than print, so they read as a lighter relief.
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.beginPath();
    g.arc(0, h / 2, h * 0.17, -Math.PI / 2, Math.PI / 2);
    g.fill();
    g.beginPath();
    g.arc(h * 0.34, h * 0.74, h * 0.08, 0, Math.PI * 2);
    g.fill();
    const cx = w / 2 + h * 0.14;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#cbd0da';
    g.font = `600 ${(h * 0.3).toFixed(1)}px ui-monospace, Consolas, monospace`;
    g.fillText(`${pkg.id}   ${code}`, cx, h * 0.36);
    if (description) {
      g.fillStyle = '#9aa2ad';
      g.font = `${(h * 0.21).toFixed(1)}px ui-monospace, Consolas, monospace`;
      g.fillText(description.toUpperCase(), cx, h * 0.68);
    }
  });
  // Printed for pin 1 at the left; a chip turned end for end carries the
  // same print rotated with it, notch and dimple included.
  if (pkg.flipped) {
    tex.center.set(0.5, 0.5);
    tex.rotation = Math.PI;
  }
  return tex;
}

function dipMarking(kit: Kit, ways: number, length: number): THREE.CanvasTexture {
  return marking(kit, length, DIP_SWITCH_HALF_Z * 2, (g, w, h) => {
    g.fillStyle = '#f6efe2';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // ON reads along the case at the end a slider is pushed to when closed.
    g.save();
    g.translate(w - h * 0.2, h * 0.5);
    g.rotate(-Math.PI / 2);
    g.font = `700 ${(h * 0.2).toFixed(1)}px ui-monospace, Consolas, monospace`;
    g.fillText('ON', 0, 0);
    g.restore();
    g.font = `${(h * 0.17).toFixed(1)}px ui-monospace, Consolas, monospace`;
    const span = w - h * 0.9;
    for (let i = 0; i < ways; i++) {
      const x = h * 0.45 + (span * i) / Math.max(1, ways - 1);
      g.fillText(String(i + 1), x, h * 0.91);
    }
  });
}

// ---------- two- and three-lead parts ----------

/** What a jumper has to fly over to cross this part or package. */
export interface Obstacle {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  top: number;
}

/** Air a jumper leaves above whatever it flies over: its own radius and more. */
export const WIRE_CLEARANCE = 11;
// Where a jumper's ends sit, the ceiling on an arch, and the height the curve
// reaches at t all belong to the wire-vs-wire planner, which has to agree with
// this file exactly and is pure enough to test on its own. Re-exported so the
// arch helpers still read as one set from here.
export { archY, MAX_ARCH, WIRE_END_Y } from '../src/render/altitude.ts';

/**
 * How high to put the two control points of a jumper's arc, so it gets from
 * one hole to the other without going through anything.
 *
 * The path is sampled in plan, away from both ends, and every body under it
 * has a say. What matters is the height the curve actually has where that body
 * stands, not the height at its peak: a chip two thirds of the way along the
 * run needs a much taller control point than one under the middle, because by
 * then the curve is already coming down. Sampling away from the ends matters
 * too, since a wire landing in the hole beside a chip is not passing over it.
 */
export function archHeight(a: [number, number], b: [number, number], control: [number, number], obstacles: Obstacle[]): number {
  const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
  // Clear of everything a jumper still bows, and a longer one bows further.
  // A cubic peaks at three quarters of its control height.
  let height = Math.min(5 + span * 0.075, 22) / 0.75;
  for (let k = 0; k <= 40; k++) {
    const t = 0.13 + (0.74 * k) / 40;
    const u = 1 - t;
    const x = u * u * a[0] + 2 * u * t * control[0] + t * t * b[0];
    const z = u * u * a[1] + 2 * u * t * control[1] + t * t * b[1];
    let needed = TOP;
    for (const o of obstacles) if (x >= o.x0 && x <= o.x1 && z >= o.z0 && z <= o.z1 && o.top > needed) needed = o.top;
    if (needed <= TOP) continue;
    // At t the curve sits at 3t(1-t) of the control height, plus what the two
    // ends contribute.
    const share = 3 * t * u;
    const ends = WIRE_END_Y * (u ** 3 + t ** 3);
    height = Math.max(height, (needed + WIRE_CLEARANCE - ends) / share);
  }
  return Math.min(height, MAX_ARCH);
}

/**
 * Which way a jumper bows, and how high, to get across without going through
 * anything.
 *
 * The flat board's own bow is kept wherever flying over works, so a wire
 * traced on one view is the same wire on the other. Where clearing a tall part
 * would need an absurd loop, the bow is mirrored and the jumper goes round it
 * instead, which is what anyone building the board would do.
 */
export function routeWire(a: [number, number], b: [number, number], control: [number, number], obstacles: Obstacle[]): { control: [number, number]; height: number } {
  const height = archHeight(a, b, control, obstacles);
  if (height < MAX_ARCH) return { control, height };
  const mirrored: [number, number] = [a[0] + b[0] - control[0], a[1] + b[1] - control[1]];
  const alternative = archHeight(a, b, mirrored, obstacles);
  return alternative < height ? { control: mirrored, height: alternative } : { control, height };
}

/** How tall a body stands and how far it spreads from its holes. */
interface Reach {
  top: number;
  radius: number;
}

/** What a running simulation needs to light one LED. */
export interface LedLamp {
  material: THREE.MeshPhysicalMaterial;
  core: THREE.MeshBasicMaterial;
  lamp: THREE.PointLight;
  /** The corona, grown and faded with how hard the LED is being driven. */
  glow: THREE.Sprite;
  spec: LedSpec;
}

export interface BuiltPart {
  object: THREE.Object3D;
  /** Set for an LED, so the running simulation can light it. */
  led?: LedLamp;
  obstacle: Obstacle;
}

/** How far an axial body rides above the board before its leads bend down. */
const AXIAL_LIFT = 9;

export function buildPart(kit: Kit, part: PlacedPart, doc: LayoutDoc): BuiltPart {
  const group = new THREE.Group();
  const holes = part.holes.map((h) => at(h));
  let led: LedLamp | undefined;
  let reach: Reach;
  if (part.kind !== 'lead2' || holes.length < 2) {
    reach = threeLegged(kit, group, part, holes);
  } else if (part.style === 'LED') {
    const spec = doc.ledColors?.[part.id] ? ledSpecFor(doc.ledColors[part.id]) : ledSpec(part.value || 'LED');
    const built = ledPart(kit, group, holes[0], holes[1], spec);
    led = built.lamp;
    reach = built.reach;
  } else if (part.style === 'R') {
    reach = resistor(kit, group, part, holes[0], holes[1], doc.resistorKind === 'metal');
  } else {
    reach = axial(kit, group, part, holes[0], holes[1]);
  }
  // A switch or a button standing on the board is flickable here too, on the
  // same key the flat board sends.
  if (part.style === 'SW' || part.style === 'BTN') group.userData.switchKey = part.id;
  return { object: group, led, obstacle: spread(holes, reach) };
}

function spread(holes: THREE.Vector3[], reach: Reach): Obstacle {
  const xs = holes.map((p) => p.x);
  const zs = holes.map((p) => p.z);
  return { x0: Math.min(...xs) - reach.radius, x1: Math.max(...xs) + reach.radius, z0: Math.min(...zs) - reach.radius, z1: Math.max(...zs) + reach.radius, top: reach.top };
}

/** The bent leads either side of an axial body, hole to hole. */
function axialLeads(kit: Kit, group: THREE.Group, a: THREE.Vector3, b: THREE.Vector3, lift: number): [THREE.Vector3, THREE.Vector3] {
  const ay = a.clone().setY(TOP + lift);
  const by = b.clone().setY(TOP + lift);
  group.add(tube(kit, a.clone().setY(TOP - 5), ay, 1.15, kit.M.tin, 8));
  group.add(tube(kit, b.clone().setY(TOP - 5), by, 1.15, kit.M.tin, 8));
  group.add(tube(kit, ay, by, 1.15, kit.M.tin, 8));
  return [ay, by];
}

function resistor(kit: Kit, group: THREE.Group, part: PlacedPart, a: THREE.Vector3, b: THREE.Vector3, metal: boolean): Reach {
  const [ay, by] = axialLeads(kit, group, a, b, AXIAL_LIFT);
  const axis = by.clone().sub(ay);
  const span = axis.length();
  // A quarter-watt body is 6.3 mm long and 2.4 mm across. If the holes sit
  // closer than that the body shrinks rather than swallowing its own leads.
  const bodyLen = Math.max(2 * MM, Math.min(6.3 * MM, span - 8));
  const r = 1.2 * MM;
  const dir = axis.clone().normalize();
  const centre = ay.clone().add(by).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
  const body = kit.mesh(new THREE.CapsuleGeometry(r, Math.max(0.5, bodyLen - r * 2), 6, 18), metal ? kit.M.bodyMetal : kit.M.body);
  body.position.copy(centre);
  body.quaternion.copy(q);
  group.add(body);

  // The colour code, read off the value the same way the checks read it, so
  // the bands can never say something other than the printed value.
  const bands = resistorBands(part.value, metal ? 'metal' : 'carbon');
  // The digit and multiplier bands grouped at one end, the tolerance band alone at the other.
  const offsets = bands?.length === 5 ? [-0.36, -0.24, -0.12, 0, 0.32] : [-0.34, -0.2, -0.06, 0.32];
  for (const [i, band] of (bands ?? []).entries()) {
    const ring = kit.mesh(new THREE.CylinderGeometry(r * 1.06, r * 1.06, bodyLen * 0.08, 18), kit.std({ color: band.hex, roughness: 0.55 }));
    ring.position.copy(centre).addScaledVector(dir, offsets[i] * bodyLen);
    ring.quaternion.copy(q);
    group.add(ring);
  }
  return { top: TOP + AXIAL_LIFT + r, radius: r };
}

function ledPart(kit: Kit, group: THREE.Group, cathode: THREE.Vector3, anode: THREE.Vector3, spec: LedSpec): { lamp: LedLamp; reach: Reach } {
  // A 5 mm LED: 2.5 mm radius, a 2.9 mm flange with the cathode flat on it,
  // and about 8.5 mm from the board to the top of the dome.
  const R = 2.5 * MM;
  const flangeR = 2.9 * MM;
  const flangeH = 1 * MM;
  const barrelH = 4.6 * MM;
  const base = TOP + 1.2 * MM;
  const centre = cathode.clone().add(anode).multiplyScalar(0.5).setY(base);

  group.add(tube(kit, cathode.clone().setY(TOP - 5), cathode.clone().setY(base + flangeH * 0.6), 1.15, kit.M.tin, 8));
  group.add(tube(kit, anode.clone().setY(TOP - 5), anode.clone().setY(base + flangeH * 0.6), 1.15, kit.M.tin, 8));

  const epoxy = kit.phys({
    color: spec.body,
    roughness: 0.22,
    metalness: 0,
    transmission: 0.5,
    ior: 1.55,
    thickness: 3 * MM,
    attenuationColor: new THREE.Color(spec.body),
    attenuationDistance: 6 * MM,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    emissive: new THREE.Color(spec.light),
    emissiveIntensity: 0,
  });

  // Built facing +x and then turned, so the flange's flat lands on the
  // cathode side. That flat is the only marking a real LED carries.
  const shell = new THREE.Group();
  shell.position.copy(centre);
  shell.rotation.y = Math.atan2(-(cathode.z - centre.z), cathode.x - centre.x);

  shell.add(kit.mesh(dFlange(flangeR, flangeR * 0.82, flangeH), epoxy));
  const barrel = kit.mesh(new THREE.CylinderGeometry(R, R, barrelH, 32), epoxy);
  barrel.position.y = flangeH + barrelH / 2;
  shell.add(barrel);
  const dome = kit.mesh(new THREE.SphereGeometry(R, 32, 20, 0, Math.PI * 2, 0, Math.PI / 2), epoxy);
  dome.position.y = flangeH + barrelH;
  shell.add(dome);

  // The lead frame you can see through the epoxy: the cathode's cup and the
  // slimmer anode post. Getting these the right way round is the difference
  // between a model of an LED and a coloured lump.
  const cup = kit.mesh(new THREE.CylinderGeometry(R * 0.5, R * 0.34, 1.4 * MM, 18, 1, true), kit.M.leg);
  cup.position.set(R * 0.42, flangeH + 1.5 * MM, 0);
  shell.add(cup);
  const post = kit.mesh(new THREE.BoxGeometry(1.6, 2.6 * MM, 3.4), kit.M.leg);
  post.position.set(-R * 0.42, flangeH + 1.3 * MM, 0);
  shell.add(post);
  // The die itself, which is the thing that actually lights.
  const core = kit.keep(new THREE.MeshBasicMaterial({ color: spec.light, transparent: true, opacity: 0 }));
  const die = new THREE.Mesh(kit.keep(new THREE.SphereGeometry(R * 0.3, 14, 10)), core);
  die.position.set(R * 0.42, flangeH + 2.1 * MM, 0);
  shell.add(die);
  group.add(shell);

  // A lit LED throws light on the board around it, which is most of what
  // makes it read as lit rather than merely painted brighter.
  const lamp = new THREE.PointLight(new THREE.Color(spec.light), 0, 26 * MM, 2);
  lamp.position.copy(centre).setY(base + flangeH + barrelH * 0.6);
  group.add(lamp);

  // The corona is centred on the dome, not above it, so it reads as a halo
  // round the LED rather than a smudge floating over it. The dome's own depth
  // hides the hottest middle of the gradient and leaves the spread, which is
  // what a glare round a light source actually looks like. Depth testing stays
  // on for the same reason it is centred here: a halo that shone through the
  // board when the camera went underneath would give the whole thing away.
  const glow = new THREE.Sprite(kit.keep(new THREE.SpriteMaterial({ map: corona(kit), color: new THREE.Color(spec.light), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 })));
  glow.position.copy(centre).setY(base + flangeH + barrelH * 0.95);
  glow.scale.setScalar(0.001);
  group.add(glow);

  return { lamp: { material: epoxy, core, lamp, glow, spec }, reach: { top: base + flangeH + barrelH + R, radius: flangeR } };
}

/** Diodes, capacitors, inductors, switches: a body between two bent leads. */
function axial(kit: Kit, group: THREE.Group, part: PlacedPart, a: THREE.Vector3, b: THREE.Vector3): Reach {
  const [ay, by] = axialLeads(kit, group, a, b, AXIAL_LIFT);
  const axis = by.clone().sub(ay);
  const span = axis.length();
  const dir = axis.clone().normalize();
  const centre = ay.clone().add(by).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
  const facing = Math.atan2(-(b.z - centre.z), b.x - centre.x);
  const along = (mesh: THREE.Mesh, offset = 0) => {
    mesh.position.copy(centre).addScaledVector(dir, offset);
    mesh.quaternion.copy(q);
    group.add(mesh);
  };

  if (part.style === 'D' || part.style === 'Z') {
    const len = Math.max(2 * MM, Math.min(4 * MM, span - 8));
    along(kit.mesh(new THREE.CapsuleGeometry(0.95 * MM, Math.max(0.5, len - 1.9 * MM), 6, 16), kit.M.glass));
    // The band marks the cathode, which the layout always puts at hole 1.
    along(kit.mesh(new THREE.CylinderGeometry(1 * MM, 1 * MM, len * 0.14, 16), kit.std({ color: '#e7e5df', roughness: 0.6 })), -len * 0.32);
    return { top: TOP + AXIAL_LIFT + 1 * MM, radius: 1 * MM };
  }
  if (part.style === 'Cpol') {
    // An electrolytic stands on its leads with the stripe down the minus
    // side, and the layout puts the plus lead in hole 1.
    const r = 2.4 * MM;
    const h = 5.5 * MM;
    const can = kit.mesh(new THREE.CylinderGeometry(r, r, h, 24), kit.std({ color: '#2f3e5c', roughness: 0.5 }));
    can.position.copy(centre).setY(TOP + AXIAL_LIFT + h / 2);
    group.add(can);
    const stripe = kit.mesh(new THREE.CylinderGeometry(r * 1.01, r * 1.01, h * 0.92, 24, 1, true, Math.PI * 0.82, Math.PI * 0.36), kit.std({ color: '#e7e5df', roughness: 0.6, side: THREE.DoubleSide }));
    stripe.position.copy(can.position);
    stripe.rotation.y = facing;
    group.add(stripe);
    return { top: TOP + AXIAL_LIFT + h, radius: r };
  }
  if (part.style === 'C') {
    const disc = kit.mesh(new THREE.CylinderGeometry(2.2 * MM, 2.2 * MM, 1.1 * MM, 22), kit.std({ color: '#c8892f', roughness: 0.66 }));
    disc.position.copy(centre).setY(TOP + AXIAL_LIFT + 2.2 * MM);
    disc.rotation.z = Math.PI / 2;
    disc.rotation.y = facing;
    group.add(disc);
    return { top: TOP + AXIAL_LIFT + 4.4 * MM, radius: 2.2 * MM };
  }
  if (part.style === 'L') {
    const len = Math.max(2 * MM, Math.min(4.5 * MM, span - 8));
    along(kit.mesh(new THREE.CapsuleGeometry(1.2 * MM, Math.max(0.5, len - 2.4 * MM), 6, 16), kit.std({ color: '#4a6b3a', roughness: 0.62 })));
    return { top: TOP + AXIAL_LIFT + 1.2 * MM, radius: 1.2 * MM };
  }
  if (part.style === 'SW' || part.style === 'BTN') {
    const box = kit.mesh(new RoundedBoxGeometry(Math.max(2 * MM, Math.min(span - 8, 6 * MM)), 3 * MM, 4 * MM, 2, 0.8), kit.M.dark);
    box.position.copy(centre).setY(TOP + AXIAL_LIFT + 1.5 * MM);
    box.rotation.y = facing;
    group.add(box);
    return { top: TOP + AXIAL_LIFT + 3 * MM, radius: 2 * MM };
  }
  along(kit.mesh(new THREE.CapsuleGeometry(1.1 * MM, Math.max(0.5, Math.min(5 * MM, span - 8) - 2.2 * MM), 6, 14), kit.M.body));
  return { top: TOP + AXIAL_LIFT + 1.1 * MM, radius: 1.1 * MM };
}

/** Transistors and potentiometers: a body standing on three real legs. */
function threeLegged(kit: Kit, group: THREE.Group, part: PlacedPart, holes: THREE.Vector3[]): Reach {
  if (!holes.length) return { top: TOP, radius: 0 };
  const centre = holes.reduce((acc, p) => acc.add(p.clone()), v3(0, 0, 0)).multiplyScalar(1 / holes.length);
  const pot = part.kind === 'pot3';
  const bodyY = TOP + (pot ? 3 * MM : 5 * MM);
  const last = holes[holes.length - 1];
  const facing = Math.atan2(-(last.z - holes[0].z), last.x - holes[0].x);

  // Every leg runs from its own hole up to the body, so the model can only
  // show the part standing in the holes the layout gave it.
  for (const h of holes) {
    const knee = h.clone().setY(bodyY - (pot ? 1.5 * MM : 2 * MM));
    group.add(tube(kit, h.clone().setY(TOP - 5), knee, 1.2, kit.M.tin, 8));
    group.add(tube(kit, knee, centre.clone().setY(bodyY - (pot ? 1 * MM : 1.2 * MM)), 1.2, kit.M.tin, 8));
  }

  if (pot) {
    const box = kit.mesh(new RoundedBoxGeometry(9.5 * MM, 3.5 * MM, 5 * MM, 3, 1), kit.std({ color: '#2f6fbf', roughness: 0.5 }));
    box.position.copy(centre).setY(bodyY + 1.75 * MM);
    box.rotation.y = facing;
    group.add(box);
    const shaft = kit.mesh(new THREE.CylinderGeometry(1.6 * MM, 1.6 * MM, 1.6 * MM, 20), kit.M.body);
    shaft.position.copy(centre).setY(bodyY + 4.3 * MM);
    group.add(shaft);
    return { top: bodyY + 5.1 * MM, radius: 5 * MM };
  }
  // TO-92: a half cylinder with the flat face across the front.
  const half = kit.mesh(new THREE.CylinderGeometry(2.3 * MM, 2.3 * MM, 4.2 * MM, 24, 1, false, Math.PI * 0.5, Math.PI), kit.M.dark);
  half.position.copy(centre).setY(bodyY);
  half.rotation.y = facing;
  group.add(half);
  const flat = kit.mesh(new THREE.BoxGeometry(4.6 * MM, 4.2 * MM, 0.6 * MM), kit.M.dark);
  flat.position.copy(centre).setY(bodyY);
  flat.rotation.y = facing;
  flat.translateZ(-0.25 * MM);
  group.add(flat);
  return { top: bodyY + 2.1 * MM, radius: 2.3 * MM };
}
