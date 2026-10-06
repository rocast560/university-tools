// A real 3D breadboard, built from the same layout the flat board is drawn
// from, so the two can never disagree about what is wired where.
//
// Everything is in the renderer's own units, where one hole pitch is 18 and
// therefore 1 mm is about 7.1. The board is modelled at true thickness, which
// is what makes it read as a physical object once you tip it over, and the
// parts are modelled at their real sizes for the same reason.
//
// The budget that keeps it smooth: every hole is one instance of one mesh and
// every chip's legs are another, so the ~900 sockets on a half board cost a
// single draw call rather than nine hundred. Materials are shared, the room
// environment is baked once at mount, and nothing is rebuilt per frame - a
// running simulation only writes emissive intensity and lamp power on the LED
// materials it already has.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Tint } from '../src/edit/placement.ts';
import type { Handle } from '../src/edit/wireshape.ts';
import { isRail } from '../src/layout/board.ts';
import type { Hole } from '../src/layout/types.ts';
import type { LayoutDoc } from '../src/pipeline.ts';
import { liftCrossings, type Span } from '../src/render/altitude.ts';
import { groupRefs, type Highlight, type PartGroup } from '../src/render/index.ts';
import { P, ROWY, tierCols, tierCount, TIER_PITCH, tierShift, X0 } from '../src/render/geometry.ts';
import { wireControls } from '../src/render/routing.ts';
import { routeWires, WIRE_R, type Point as PlanPoint, type WireRoute } from '../src/render/route3d.ts';
import type { AnalogState } from '../src/sim/analog/simulator.ts';
import { at, BOARD_THICK, buildPackage, buildPart, grainMap, holeX, holeZ, Kit, MM, routeWire, seededRandom, setHoleBoard, TOP, tube, WIRE_CLEARANCE, WIRE_END_Y, type LedLamp, type Obstacle, type SevenSegLamp, type Way } from './board3d-parts.ts';
import { easeOutCubic, frameBox } from './editor3d/focus-math.ts';
import { flyControls } from './fly.ts';
import type { V3 } from './wiretube-math.ts';
import { buildWireMeshes, reshapeWire, type WireMeshes } from './wiretube.ts';

/**
 * The printed top surface, drawn once into a canvas: the moulded grain, the
 * rail stripes, the shading round every socket, and the row letters and column
 * numbers a real board carries. One texture is far cheaper than geometry for
 * any of it, and it is what makes the board read as a manufactured object
 * rather than a slab.
 */
function topTexture(doc: LayoutDoc, width: number, depth: number, offset = 0): THREE.CanvasTexture {
  const scale = 2;
  const cv = document.createElement('canvas');
  cv.width = Math.round(width * scale);
  cv.height = Math.round(depth * scale);
  const g = cv.getContext('2d')!;
  g.scale(scale, scale);
  g.fillStyle = '#e8e2d1';
  g.fillRect(0, 0, width, depth);

  // Grain: a lot of very low contrast speckles beats a noise filter here,
  // because it stays crisp when you put the camera right down on the board.
  // Seeded, because every move rebuilds the scene and a re-rolled grain makes
  // the whole surface visibly shimmer.
  const random = seededRandom(0xc2b2ae35);
  for (let i = 0; i < 26000; i++) {
    const a = random() * 0.05;
    g.fillStyle = random() > 0.5 ? `rgba(120,112,92,${a})` : `rgba(255,252,242,${a})`;
    g.fillRect(random() * width, random() * depth, 1.4, 1.4);
  }

  // One board's worth: a stacked layout paints each board separately, numbering
  // its columns from where the one above it stopped.
  const cols = tierCols(doc.board);
  for (const [row, colour] of [['T+', '#d7263d'], ['T-', '#2f6fbf'], ['B-', '#2f6fbf'], ['B+', '#d7263d']] as const) {
    g.strokeStyle = colour;
    g.globalAlpha = 0.5;
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(X0 - 12, ROWY[row]);
    g.lineTo(X0 + (cols - 1) * P + 12, ROWY[row]);
    g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = colour;
    g.font = 'bold 13px ui-monospace, monospace';
    g.textAlign = 'center';
    g.fillText(row[1], X0 + (cols - 1) * P + 26, ROWY[row] + 5);
    g.fillText(row[1], X0 - 26, ROWY[row] + 5);
  }

  // A moulded lip round every socket. Without it the holes read as stickers
  // once the camera comes down to board level.
  const lip = (x: number, z: number) => {
    g.strokeStyle = 'rgba(96,90,74,0.30)';
    g.lineWidth = 1.1;
    g.strokeRect(x - 4.1, z - 4.1, 8.2, 8.2);
    g.strokeStyle = 'rgba(255,253,246,0.55)';
    g.lineWidth = 0.9;
    g.strokeRect(x - 5.1, z - 5.1, 10.2, 10.2);
  };
  for (const row of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const) for (let c = 1; c <= cols; c++) lip(X0 + (c - 1) * P, ROWY[row]);
  for (const row of ['T+', 'T-', 'B-', 'B+'] as const) for (let c = 1; c <= cols; c++) if (c % doc.board.railGapEvery !== 0) lip(X0 + (c - 1) * P, ROWY[row]);

  g.fillStyle = '#6b6455';
  g.font = '11px ui-monospace, monospace';
  g.textAlign = 'center';
  for (const row of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const) {
    g.fillText(row, X0 - 20, ROWY[row] + 4);
    g.fillText(row, X0 + (cols - 1) * P + 20, ROWY[row] + 4);
  }
  g.font = '10px ui-monospace, monospace';
  for (let c = 1; c <= cols; c++) {
    if (c !== 1 && (c + offset) % 5 !== 0) continue;
    g.fillText(String(c + offset), X0 + (c - 1) * P, ROWY.a - 12);
    g.fillText(String(c + offset), X0 + (c - 1) * P, ROWY.j + 18);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * The same top surface as a height field, so its relief is lit rather than
 * painted.
 *
 * The lips drawn into the colour texture are shading: they look moulded from
 * above and go completely flat the moment you bring the camera down to board
 * level, which is exactly where this view is most useful. As a bump map the
 * same shapes catch whatever light is actually falling on them, from any
 * angle, for one more canvas and no extra geometry.
 */
function topBump(doc: LayoutDoc, width: number, depth: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = Math.round(width);
  cv.height = Math.round(depth);
  const g = cv.getContext('2d')!;
  // Mid grey is the board's own level: lighter stands proud, darker is sunk.
  g.fillStyle = '#808080';
  g.fillRect(0, 0, width, depth);
  const socket = (x: number, z: number) => {
    g.fillStyle = '#b9b9b9';
    g.fillRect(x - 5.2, z - 5.2, 10.4, 10.4);
    g.fillStyle = '#6a6a6a';
    g.fillRect(x - 4, z - 4, 8, 8);
    // The hole itself, which is what the eye reads as depth up close.
    g.fillStyle = '#2b2b2b';
    g.fillRect(x - 2.4, z - 2.4, 4.8, 4.8);
  };
  const cols = tierCols(doc.board);
  for (const row of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const) for (let c = 1; c <= cols; c++) socket(X0 + (c - 1) * P, ROWY[row]);
  for (const row of ['T+', 'T-', 'B-', 'B+'] as const) for (let c = 1; c <= cols; c++) if (c % doc.board.railGapEvery !== 0) socket(X0 + (c - 1) * P, ROWY[row]);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 8;
  return tex;
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Reused when driving a die towards white; allocating one per frame is waste. */
const WHITE = new THREE.Color(0xffffff);

export type Pick = { kind: 'part'; ref: string } | { kind: 'wire'; net: string; index: number } | { kind: 'switch'; key: string } | null;

export interface Board3D {
  dispose(): void;
  /** A frame from the running analog solver: how brightly each LED runs. */
  setState(s: AnalogState | null): void;
  /**
   * Where the switches stand and, for when nothing is running, which LEDs the
   * boolean simulator says are lit.
   */
  setBoard(switches: Record<string, boolean>, leds: Record<string, boolean>, segments?: Record<string, Record<string, boolean>>): void;
  /**
   * Follow one thing: a net, a single jumper, or a part. Every jumper that is
   * not part of it disappears, so the followed run can be traced through the
   * tangle, and the followed net glows. Null shows everything again.
   */
  setHighlight(hl: Highlight | null): void;
  /** Light a net as if the pointer were over one of its wires. */
  setHover(net: string | null): void;
  resize(): void;
  resetView(): void;
  /** Turn free flight on or off. Orbit drives the camera whenever it is off. */
  setFly(on: boolean): void;
  readonly flying: boolean;
  /** Swap every part, package and wire for those of `doc` (and the jumper style, when given); renderer, lights and camera stay. */
  rebuild(doc: LayoutDoc, wireStyle?: 'arc' | 'orthogonal'): void;
  /** What is under a pointer event: a switch, a part or a jacket, in that order. */
  pick(e: { clientX: number; clientY: number }): Pick;
  /** The pointer projected onto the board's top surface, in plan (SVG) units [x, y]. */
  boardPoint(e: { clientX: number; clientY: number }): [number, number] | null;
  /** Outline one part (selected) and optionally another more faintly (hovered). */
  setSelected(ref: string | null): void;
  setHovered(ref: string | null): void;
  /** Slide a part's mesh by a plan offset while it is being dragged; (0, 0) puts it back. */
  nudge(ref: string, dx: number, dy: number): void;
  /** Tint the strips under the given legs; an empty list clears them. */
  setStripTint(tints: Tint[]): void;
  /** A translucent stand-in for a part not on the board yet: the tray's drop preview. */
  setGhost(g: { holes: Hole[]; footprint: 'lead2' | 'dip' | 'other'; ok: boolean } | null): void;
  /** Screen position (CSS px, relative to the canvas) of a part's top centre. */
  anchor(ref: string): { x: number; y: number; visible: boolean } | null;
  /** Glide the camera to frame one part. */
  focus(ref: string): void;
  /** Glide the camera to frame one jumper, by its index in `doc.wires`. */
  focusWire(index: number): void;
  /** Called once per rendered frame. Returns an unsubscribe. */
  onFrame(fn: () => void): () => void;
  /** The canvas, so the workspace can listen on it before OrbitControls does. */
  readonly dom: HTMLCanvasElement;
  /** Orbit on or off; off while the editor owns a drag. */
  setOrbit(on: boolean): void;
  /** Mark one jumper as selected with an accent line along its top; null clears it. */
  setWireSelected(index: number | null): void;
  /**
   * Draw a jumper along `plan` while its handle is dragged, red when `bad`;
   * null puts back its routed shape. Only this wire's buffers are rebuilt.
   * Square wires only.
   */
  setWirePreview(index: number, plan: PlanPoint[] | null, bad?: boolean): void;
  /** Draw drag handles (an empty list clears them); `selectedBend` is drawn picked. */
  setHandles(list: Handle[], selectedBend?: number | null): void;
  /** The handle under a pointer event, if any. */
  pickHandle(e: { clientX: number; clientY: number }): { kind: 'segment' | 'bend'; index: number } | null;
  /** Screen position (CSS px, relative to the canvas) of a point in the scene. */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean };
  /** Screen position of the middle of a jumper, for the wire card. */
  wireAnchor(index: number): { x: number; y: number; visible: boolean } | null;
}

export interface Board3DOptions {
  /** Called when a switch on the board is clicked, with its board-wide key. */
  onToggle?(key: string): void;
  /** The net under the pointer, or null when the pointer leaves the wires. */
  onNet?(net: string | null): void;
  /** A click on a jumper (its net) or on nothing clickable (null), to follow or release a net. */
  onSelectNet?(net: string | null): void;
  /** Which of the two ways of moving the camera is currently in charge. */
  onMode?(mode: 'orbit' | 'fly'): void;
  /** Jumpers as bowed arcs, or as square-cornered runs matching the flat board's square view. */
  wireStyle?: 'arc' | 'orthogonal';
  /** The browser took the WebGL context away (a GPU reset, too many contexts). The board is dead after this. */
  onContextLost?(): void;
}


/** Everything drawn from one doc: thrown away whole and built again on an edit. */
interface Content {
  kit: Kit;
  root: THREE.Group;
  ways: Way[];
  displays: Map<string, SevenSegLamp>;
  leds: Map<string, LedLamp>;
  pickable: THREE.Object3D[];
  wirePick: THREE.Object3D[];
  wireObjs: { net: string; objs: THREE.Object3D[] }[];
  netMat: Map<string, THREE.MeshStandardMaterial>;
  netColour: Map<string, THREE.Color>;
  tinMat: Map<string, THREE.MeshStandardMaterial>;
  /** ref -> the group holding that part or package, for picking, outlines, nudges and focus. */
  partObj: Map<string, THREE.Object3D>;
  /** Square wires, in wire order (null for arcs): their meshes, for the drag preview. */
  shapes: (WireMeshes | null)[];
  /** The routes those were built from, so a preview can be put back. */
  routes: WireRoute[];
  /** Every jumper's centre line, in wire order, for the selection line and the wire card. */
  lines: V3[][];
  /** Jackets of wires the router could not route cleanly, one material per net. */
  warnMat: Map<string, THREE.MeshStandardMaterial>;
  doc: LayoutDoc;
}

export function mount3d(container: HTMLElement, doc: LayoutDoc, opts: Board3DOptions = {}): Board3D & { /** internal, e2e only */ _tintCount(): number; _ghostCount(): number; _wireTop(): number; _loseContext(): void; _handles(): { kind: 'segment' | 'bend'; index: number; x: number; y: number }[] } {
  /** One board's depth; stacked boards sit one TIER_PITCH apart. */
  const boardDepth = 350;
  const depthOf = (d: LayoutDoc) => boardDepth + (tierCount(d.board) - 1) * TIER_PITCH;
  const depth = depthOf(doc);
  const cz = depth / 2;
  /** The middle of a doc's board along x; it widens when an edit adds columns. */
  const centreOf = (d: LayoutDoc) => (X0 + (tierCols(d.board) - 1) * P + X0) / 2;
  // The lights stay where the mounted board put them; only the content is rebuilt.
  const cx = centreOf(doc);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  // Capping the pixel ratio is the single biggest lever on a high-DPI screen:
  // rendering at 3x costs nine times the fragments for no visible gain here.
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  // Soft edges. A breadboard is lit by room light and diffuse panels, not by a
  // point source, so a hard-edged shadow under a chip is the one thing that
  // gives the render away even when everything else is right.
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';

  const scene = new THREE.Scene();
  // A dark room, not a bright one. A lit LED against a pale background is a
  // slightly yellower dot; against near-black it is a lamp, which is the whole
  // point of watching a circuit run. The board stays lit by its own key light
  // rather than by the background, so nothing else gets harder to read.
  scene.background = new THREE.Color('#070910');

  // A baked room gives every material something to reflect. It is the single
  // change that separates plastic and metal from flat shaded colour, and it
  // costs one render at mount rather than anything per frame. Turned well down
  // from its daylight value: on a dark ground a strong environment washes the
  // board out and flattens exactly the relief the bump maps just bought.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envTarget = pmrem.fromScene(room, 0.04);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 0.3;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(38, 1, 5, 8000);

  // ---------- how a lit LED reaches the eye ----------
  // A running LED is far brighter than anything else on the board, and a
  // display cannot show that. Eyes and cameras resolve it by bleeding: the
  // emitter grows a halo, its light spills onto what is beside it, and the
  // middle burns out. Without that an LED can never look brighter than white
  // paper, which is why turning the emissive up alone reads as "painted a
  // lighter colour" rather than "lit".
  //
  // A full-frame bloom pass was tried for this and is the wrong tool here. Tone
  // mapping happens after such a pass, so the threshold has to be judged
  // against raw scene radiance, and a board under a key light is already well
  // above any threshold an LED would clear: the whole board bloomed and the
  // render turned to fog. The halo is drawn per LED instead, by the lamps that
  // have earned one - see glow() in board3d-parts.ts.

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.zoomSpeed = 0.9;
  controls.rotateSpeed = 0.85;
  controls.panSpeed = 0.8;
  controls.minDistance = 60;
  controls.maxDistance = 3000;
  // Middle mouse orbits, as asked. Left does too because it is what everyone
  // reaches for, and right pans. No polar clamp: the point is to be able to
  // look at the underside.
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
  controls.target.set(cx, TOP - BOARD_THICK / 2, cz);

  // Orbit always points at one pivot, which is the wrong tool for getting in
  // among the parts to see which hole a lead lands in. Fly mode is the second
  // way to move, and only one of the two drives the camera at a time.
  const fly = flyControls(camera, renderer.domElement);
  /** Off while the editor owns a drag; landing from flight must not turn it back on. */
  let orbitOn = true;
  const setFly = (on: boolean) => {
    if (on === fly.active) return;
    if (on) {
      if (fly.enable()) {
        controls.enabled = false;
        opts.onMode?.('fly');
      }
    } else {
      fly.disable();
    }
  };
  fly.onExit = () => {
    controls.enabled = orbitOn;
    // Hand orbit a pivot in front of wherever the flight ended, or the first
    // drag after landing would swing the camera back across the board.
    const ahead = new THREE.Vector3();
    camera.getWorldDirection(ahead);
    controls.target.copy(camera.position).addScaledVector(ahead, 400);
    controls.update();
    opts.onMode?.('orbit');
  };

  // Sky above, near-black below: on a dark ground the old warm bounce read as
  // haze rather than as light coming off a bench.
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x090b11, 0.32));
  const key = new THREE.DirectionalLight(0xfff6e8, 2.6);
  key.position.set(cx - 420, 900, cz - 260);
  key.target.position.set(cx, TOP, cz);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  // One ortho frustum wide enough for the widest board (all 63 columns), since
  // an edit can grow the board after mount and the lights are not rebuilt.
  const reach = Math.max(X0 + 62 * P + X0, depth) * 0.8;
  const sc = key.shadow.camera;
  sc.left = -reach;
  sc.right = reach;
  sc.top = reach;
  sc.bottom = -reach;
  sc.near = 10;
  sc.far = 3000;
  sc.updateProjectionMatrix();
  // A leg is two units thick, so the depth bias has to stay small; normalBias
  // does the work of keeping the board out of its own shadow.
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 2;
  scene.add(key);
  scene.add(key.target);
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.42);
  fill.position.set(cx + 600, 300, cz + 700);
  scene.add(fill);
  // Being able to look at the underside is the point of this view, so it has
  // to be lit. Without this the board goes black the moment you tip past level.
  const under = new THREE.DirectionalLight(0xfff2e0, 0.55);
  under.position.set(cx + 200, -800, cz + 200);
  scene.add(under);
  // A cold rim from behind. With no ground plane to sit on - there is none, so
  // that the underside stays visible - this edge is what stops the board from
  // dissolving into the dark background at a grazing angle.
  const rim = new THREE.DirectionalLight(0x9fc0ff, 0.9);
  rim.position.set(cx + 300, 260, cz - 900);
  scene.add(rim);

  // ---------- everything drawn from the doc ----------
  // The board, its sockets, parts, jumpers and supply leads are built by one
  // function from one doc, so an edit can throw them all away and build them
  // again while the renderer, lights and camera stay put.
  //
  // `build` reads the jumper style from this, not from opts, so a style
  // change is a rebuild rather than a remount.
  let wireStyle = opts.wireStyle ?? 'arc';
  function build(doc: LayoutDoc): Content {
    const kit = new Kit();
    const M = kit.M;
    // Holes on a stacked layout land on their own board; set before anything is built.
    setHoleBoard(doc.board);
    const tiers = tierCount(doc.board);
    const width = X0 + (tierCols(doc.board) - 1) * P + X0;
    const cx = width / 2;

    const bump = kit.keep(topBump(doc, width, boardDepth));
    const topMats = Array.from({ length: tiers }, (_, k) => kit.std({ map: kit.keep(topTexture(doc, width, boardDepth, k * tierCols(doc.board))), bumpMap: bump, bumpScale: 1.6, roughness: 0.8, metalness: 0.02 }));

    const root = new THREE.Group();

    // ---------- slab and channel ----------
    // BoxGeometry takes one material per face: +x -x +y -y +z -z.
    for (let k = 0; k < tiers; k++) {
      const dz = k * TIER_PITCH;
      const slab = new THREE.Mesh(kit.keep(new THREE.BoxGeometry(width, BOARD_THICK, boardDepth)), [M.board, M.board, topMats[k], M.backing, M.board, M.board]);
      slab.position.set(cx, TOP - BOARD_THICK / 2, boardDepth / 2 + dz);
      slab.receiveShadow = true;
      root.add(slab);

      const channel = new THREE.Mesh(kit.keep(new THREE.BoxGeometry(width - 40, BOARD_THICK * 0.42, 12)), M.channel);
      channel.position.set(cx, TOP - BOARD_THICK * 0.21 + 0.2, (ROWY.e + ROWY.f) / 2 + dz);
      channel.receiveShadow = true;
      root.add(channel);
    }

    // ---------- sockets: every hole in one draw call ----------
    // Every column of every board; at() puts each on its own board.
    const cols = doc.board.cols;
    const holes: Hole[] = [];
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const;
    for (const row of rows) for (let c = 1; c <= cols; c++) holes.push({ col: c, row });
    for (const row of ['T+', 'T-', 'B-', 'B+'] as const) for (let c = 1; c <= cols; c++) if (c % doc.board.railGapEvery !== 0) holes.push({ col: c, row });
    // Kept, like the geometry: only the mesh's own dispose frees its instance buffers.
    const socket = kit.keep(new THREE.InstancedMesh(kit.keep(new THREE.BoxGeometry(6.4, 7, 6.4)), M.socket, holes.length));
    socket.receiveShadow = true;
    const m4 = new THREE.Matrix4();
    holes.forEach((h, i) => socket.setMatrixAt(i, m4.makeTranslation(holeX(h), TOP - 3.2, holeZ(h))));
    socket.instanceMatrix.needsUpdate = true;
    root.add(socket);

    // ---------- packages, parts and their lamps ----------
    // Obstacles are collected as they are built, so a jumper is routed over
    // whatever is actually on the board rather than over a guess at it.
    const obstacles: Obstacle[] = [];
    const ways: Way[] = [];
    const displays = new Map<string, SevenSegLamp>();
    const pickable: THREE.Object3D[] = [];
    const collectPickable = (o: THREE.Object3D) =>
      o.traverse((n) => {
        if (typeof n.userData.switchKey !== 'string') return;
        pickable.push(n);
        n.traverse((m) => m.layers.enable(3));
      });
    // Parts on layer 1, jackets on 2, switch ways on 3, so a pick can ask one
    // question at a time rather than sorting one mixed list of hits.
    const partObj = new Map<string, THREE.Object3D>();
    const PART_LAYER = 1;
    const tag = (obj: THREE.Object3D, ref: string) => {
      obj.userData.ref = ref;
      obj.traverse((n) => n.layers.enable(PART_LAYER));
      partObj.set(ref, obj);
    };

    for (const pkg of doc.packages) {
      const built = buildPackage(kit, pkg, doc);
      root.add(built.object);
      tag(built.object, pkg.id);
      ways.push(...built.ways);
      if (built.display) displays.set(pkg.id, built.display);
      collectPickable(built.object);
      const xs = Object.values(doc.pinHoles[pkg.id] ?? {}).map(holeX);
      if (built.obstacle) obstacles.push(built.obstacle);
      else if (xs.length) obstacles.push({ x0: Math.min(...xs) - 10, x1: Math.max(...xs) + 10, z0: ROWY.e - 10 + tierShift(doc.board, pkg.col0)[1], z1: ROWY.f + 10 + tierShift(doc.board, pkg.col0)[1], top: built.top });
    }

    const leds = new Map<string, LedLamp>();
    for (const part of doc.parts) {
      const built = buildPart(kit, part, doc);
      root.add(built.object);
      tag(built.object, part.id);
      obstacles.push(built.obstacle);
      collectPickable(built.object);
      if (built.led) leds.set(part.id, built.led);
    }

    // ---------- jumper wires ----------
    // A real jumper bows above the board and to one side, which is what
    // separates one crossing from another. The sideways bow is the same one the
    // flat board draws, so a wire traced on one is the same wire here.
    // Two passes, and the order matters. The first asks only what each jumper
    // has to clear on the board beneath it. The second asks what the other
    // jumpers are doing and lifts one of every crossing pair until there is
    // daylight between them. Because that second pass only ever raises a wire,
    // a jumper moved out of a neighbour's way can never be dropped back into the
    // chip the first pass flew it over.
    const plan = wireControls(doc.wires, (h) => [holeX(h), holeZ(h)]);
    const spans: Span[] = doc.wires.map((w, i) => {
      const a: [number, number] = [holeX(w.a), holeZ(w.a)];
      const b: [number, number] = [holeX(w.b), holeZ(w.b)];
      const route = routeWire(a, b, plan[i], obstacles);
      return { a, b, control: route.control, height: route.height };
    });
    const heights = liftCrossings(spans);

    // One jacket material per net rather than per wire, so lighting a whole net
    // up on hover is a handful of material writes instead of a walk of the scene.
    const jacketGrain = grainMap(kit, 3, 0.3, 0.52);
    const netMat = new Map<string, THREE.MeshStandardMaterial>();
    const netColour = new Map<string, THREE.Color>();
    // The tinned ends get a material per net too, so a faded net fades whole.
    const tinMat = new Map<string, THREE.MeshStandardMaterial>();
    const tinFor = (net: string) => {
      let m = tinMat.get(net);
      if (!m) {
        m = kit.keep(M.tin.clone());
        tinMat.set(net, m);
      }
      return m;
    };
    const jacketFor = (net: string) => {
      let m = netMat.get(net);
      if (!m) {
        const colour = doc.nets[net]?.color ?? '#444';
        m = kit.std({ color: colour, roughness: 0.38, metalness: 0.02, roughnessMap: jacketGrain });
        netMat.set(net, m);
        netColour.set(net, new THREE.Color(colour));
      }
      return m;
    };

    /** Every jacket, so a hover can be resolved against the wires alone. */
    const wirePick: THREE.Object3D[] = [];
    /** Core and jacket of each jumper, in wire order, so a highlight can hide the rest. */
    const wireObjs: { net: string; objs: THREE.Object3D[] }[] = [];

    // How high a jumper must climb straight up out of a hole before bowing
    // away: clear of anything standing within a pitch of that hole, so the
    // end of a long wire never sweeps through the side of a chip or the
    // display it lands beside.
    const endRise = (p: THREE.Vector3): number => {
      let top = TOP + 6;
      for (const o of obstacles) if (p.x >= o.x0 - P && p.x <= o.x1 + P && p.z >= o.z0 - P && p.z <= o.z1 + P) top = Math.max(top, o.top + WIRE_CLEARANCE);
      return top;
    };
    const square = wireStyle === 'orthogonal';
    const routes: WireRoute[] = square ? (doc.routes ?? routeWires(doc).routes) : [];
    const shapes: (WireMeshes | null)[] = [];
    const lines: V3[][] = [];
    // A wire the router could not route cleanly keeps its colour but glows red.
    const warnMat = new Map<string, THREE.MeshStandardMaterial>();
    const warnFor = (net: string) => {
      let m = warnMat.get(net);
      if (!m) {
        m = kit.std({ color: doc.nets[net]?.color ?? '#444', emissive: '#ff2a2a', emissiveIntensity: 0.55, roughness: 0.38, metalness: 0.02 });
        warnMat.set(net, m);
      }
      return m;
    };
    for (const [i, w] of doc.wires.entries()) {
      const a = at(w.a, WIRE_END_Y);
      const b = at(w.b, WIRE_END_Y);
      const length = a.distanceTo(b);
      if (square) {
        // Flat on the board, as a hand-wired board is: up out of each hole,
        // down onto the plastic, along the routed plan with a hump wherever it
        // crosses a wire laid before it, and down into the other hole.
        const r = routes[i];
        let base = TOP + WIRE_R;
        // Only the simple router's fallback can pass over a body: lift it clear.
        if (r.warning) for (const o of obstacles) for (const [px, pz] of r.plan) if (px >= o.x0 - 2 && px <= o.x1 + 2 && pz >= o.z0 - 2 && pz <= o.z1 + 2) base = Math.max(base, o.top + WIRE_CLEARANCE);
        const jacket = r.warning ? warnFor(w.net) : jacketFor(w.net);
        const built = buildWireMeshes(kit, r.plan, r.lifts, base, jacket, tinFor(w.net));
        built.jacket.userData.net = w.net;
        built.jacket.userData.wire = i;
        built.jacket.layers.enable(2);
        root.add(built.jacket, built.tin);
        wirePick.push(built.jacket);
        wireObjs.push({ net: w.net, objs: [built.jacket, built.tin] });
        shapes.push(built);
        lines.push(built.line);
        continue;
      }
      shapes.push(null);
      // Putting both cubic controls on the quadratic's own control point keeps
      // the plan view identical to the arc the flat board draws, so only the
      // height is left to choose.
      const q = v(spans[i].control[0], 0, spans[i].control[1]);
      const riseA = endRise(a);
      const riseB = endRise(b);
      const height = Math.max(heights[i], riseA + 4, riseB + 4);
      const a2 = a.clone().setY(riseA);
      const b2 = b.clone().setY(riseB);
      const c1 = a2.clone().lerp(q.clone().setY(height), 2 / 3).setY(height);
      const c2 = b2.clone().lerp(q.clone().setY(height), 2 / 3).setY(height);
      const curve = new THREE.CurvePath<THREE.Vector3>();
      curve.add(new THREE.LineCurve3(a, a2));
      curve.add(new THREE.CubicBezierCurve3(a2, c1, c2, b2));
      curve.add(new THREE.LineCurve3(b2, b));
      // The tinned core runs the whole way; the coloured jacket stops short of
      // each end, exactly where a real jumper is stripped.
      const core = kit.mesh(new THREE.TubeGeometry(curve, 56, 2.1, 8, false), tinFor(w.net));
      root.add(core);
      const pts = curve.getPoints(56);
      const cut = Math.max(1, Math.round(56 * Math.min(0.18, 7 / Math.max(length, 20))));
      const jacket = new THREE.CatmullRomCurve3(pts.slice(cut, pts.length - cut));
      const mesh = kit.mesh(new THREE.TubeGeometry(jacket, 56, 4, 10, false), jacketFor(w.net));
      mesh.userData.net = w.net;
      mesh.userData.wire = i;
      lines.push(jacket.getPoints(56).map((p) => [p.x, p.y, p.z] as V3));
      root.add(mesh);
      mesh.layers.enable(2);
      wirePick.push(mesh);
      wireObjs.push({ net: w.net, objs: [core, mesh] });
    }

    // ---------- supply leads ----------
    // Where the power actually comes from. The flat board draws these off the
    // left margin, and leaving them out of the 3D board made it look as though
    // the rails fed themselves.
    for (const [i, lead] of (doc.supply?.leads ?? []).entries()) {
      const end = at(lead.hole, TOP - 4);
      const off = v(-90, TOP + 30 + i * 12, end.z + (i - 0.5) * 26);
      const curve = new THREE.QuadraticBezierCurve3(off, v((off.x + end.x) / 2, TOP + 46, (off.z + end.z) / 2), end);
      const colour = doc.nets[lead.net]?.color ?? '#444';
      root.add(kit.mesh(new THREE.TubeGeometry(curve, 40, 4.4, 10, false), kit.std({ color: colour, roughness: 0.4 })));
      root.add(tube(kit, end, end.clone().setY(TOP + 8), 2.1, M.tin, 8));
    }

    return { kit, root, ways, displays, leds, pickable, wirePick, wireObjs, netMat, netColour, tinMat, partObj, shapes, routes, lines, warnMat, doc };
  }
  let c = build(doc);
  scene.add(c.root);

  // ---------- picking ----------
  // Clicking is deliberately resolved on pointerup, and only when the pointer
  // barely moved, because the same button orbits the camera. Each question is
  // asked on its own layer, so a switch beats the part it sits in and a part
  // beats a jumper passing over it.
  const dom = renderer.domElement;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const toNdc = (e: { clientX: number; clientY: number }) => {
    const rect = dom.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  };
  /** Nearest hit on one layer, walked up to the object that carries `key`, with how far away it is. */
  const hitOn = (layer: number, key: 'switchKey' | 'ref' | 'net', within: THREE.Object3D[]): { id: string; distance: number; obj: THREE.Object3D } | null => {
    ray.layers.set(layer);
    for (const hit of ray.intersectObjects(within, true)) {
      // three's raycaster ignores `visible`, so a jumper hidden by a held
      // highlight would still catch the click meant for what is behind it.
      let hidden = false;
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) if (!o.visible) hidden = true;
      if (hidden) continue;
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) if (typeof o.userData[key] === 'string') return { id: o.userData[key] as string, distance: hit.distance, obj: o };
    }
    return null;
  };
  const pick = (e: { clientX: number; clientY: number }): Pick => {
    toNdc(e);
    const sw = hitOn(3, 'switchKey', c.pickable);
    if (sw) return { kind: 'switch', key: sw.id };
    // A part and a jumper are judged by depth: a jumper arching over a chip is
    // in front of it and must still be followable, and a chip in front of a
    // jumper hides it.
    const part = hitOn(1, 'ref', [...c.partObj.values()]);
    const wire = hitOn(2, 'net', c.wirePick);
    if (part && (!wire || part.distance <= wire.distance)) return { kind: 'part', ref: part.id };
    return wire ? { kind: 'wire', net: wire.id, index: wire.obj.userData.wire as number } : null;
  };
  const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TOP);
  const planeHit = new THREE.Vector3();
  const boardPoint = (e: { clientX: number; clientY: number }): [number, number] | null => {
    toNdc(e);
    return ray.ray.intersectPlane(boardPlane, planeHit) ? [planeHit.x, planeHit.z] : null;
  };

  // ---------- following a net ----------
  // Colour alone stops answering on a board with more nets than distinct
  // colours, and on a crowded board even a distinct colour is hard to follow
  // through a tangle. Hovering any wire lifts its whole net out of the board:
  // that net glows, every other net drops back, and what is joined to what
  // stops being something you trace and becomes something you see.
  let hovered: string | null = null;
  /** The net a held highlight keeps lit, under whatever the pointer is over. */
  let litNet: string | null = null;
  // three compiles an "opaque" variant of a material's shader while
  // material.transparent is false, so flipping it needs a recompile or the
  // opacity is ignored; setting it only when it changes keeps that rare.
  const fade = (m: THREE.MeshStandardMaterial, faded: boolean) => {
    if (m.transparent !== faded) {
      m.transparent = faded;
      m.needsUpdate = true;
    }
    m.opacity = faded ? 0.14 : 1;
    m.depthWrite = !faded;
  };
  /** The Show filter is on: every jumper turns to glass unless its net is lit. */
  let wiresGlass = false;
  const paintNets = () => {
    const net = hovered ?? litNet;
    for (const [id, m] of c.netMat) {
      const base = c.netColour.get(id)!;
      const tin = c.tinMat.get(id);
      const faded = net ? id !== net : wiresGlass;
      m.color.copy(base);
      // The lit net carries its own colour as emissive, so it reads as lit
      // rather than merely pale; everything else turns to glass: still there
      // to show where it runs, but the lit net reads through it.
      if (net && !faded) m.emissive.copy(base).multiplyScalar(0.45);
      else m.emissive.setRGB(0, 0, 0);
      fade(m, faded);
      if (tin) fade(tin, faded);
    }
    for (const [id, m] of c.warnMat) fade(m, !!net && id !== net);
  };
  const setHoveredNet = (net: string | null) => {
    if (net === hovered) return;
    hovered = net;
    paintNets();
    opts.onNet?.(net);
  };

  // ---------- holding a highlight ----------
  // The build guide's step and the followed net both arrive here. Hiding the
  // other jumpers outright, rather than dimming them, is what makes a run
  // traceable in 3D: a dimmed wire still occludes the one behind it.
  const netsOfRef = (ref: string): Set<string> => {
    const nets = new Set<string>();
    for (const part of c.doc.parts) if (part.id === ref) for (const n of part.nets) nets.add(n);
    for (const po of c.doc.pinouts) if (po.ref === ref) for (const pin of po.pins) if (pin.net) nets.add(pin.net);
    return nets;
  };
  // ---------- the Show filter ----------
  // Parts share their materials (every chip is the same epoxy), so a part is
  // faded by swapping in a see-through copy of each of its materials and put
  // back by swapping the original in again. Copies are made once per material.
  const glassOf = new Map<THREE.Material, THREE.Material>();
  const glass = (m: THREE.Material): THREE.Material => {
    let g = glassOf.get(m);
    if (!g) {
      g = m.clone();
      g.transparent = true;
      g.opacity = 0.14;
      g.depthWrite = false;
      glassOf.set(m, g);
    }
    return g;
  };
  const fadePart = (obj: THREE.Object3D, faded: boolean) =>
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.material) return;
      if (faded && !o.userData.solid) {
        o.userData.solid = mesh.material;
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(glass) : glass(mesh.material);
      } else if (!faded && o.userData.solid) {
        mesh.material = o.userData.solid;
        delete o.userData.solid;
      }
    });
  const showGroup = (group: PartGroup | null) => {
    const keep = group ? groupRefs(c.doc, group) : null;
    for (const [ref, obj] of c.partObj) fadePart(obj, !!keep && !keep.has(ref));
    wiresGlass = !!keep;
  };

  /** The last highlight asked for, so a rebuild can hold it on the new wires. */
  let held: Highlight | null = null;
  const setHighlight = (hl: Highlight | null) => {
    held = hl;
    const refNets = hl?.ref !== undefined ? netsOfRef(hl.ref) : null;
    const soft = !!hl?.soft;
    c.wireObjs.forEach((w, i) => {
      const keep = !hl ? true : hl.wire !== undefined ? i === hl.wire : hl.net !== undefined ? w.net === hl.net : refNets ? refNets.has(w.net) : true;
      // Soft: the rest stays as glass, so the followed net reads in context.
      // Hard: the rest goes, so the run can be traced clean.
      for (const o of w.objs) o.visible = keep || soft;
    });
    litNet = hl?.net ?? (hl?.wire !== undefined ? (c.doc.wires[hl.wire]?.net ?? null) : null);
    paintNets();
  };

  // ---------- selection outline ----------
  // An edge overlay rather than a post-processing outline pass: a pass would
  // mean an EffectComposer, which loses the canvas's MSAA and has to be taught
  // the tone mapping, for the sake of one part. Lines drawn on top of the
  // part's own meshes cost nothing when nothing is selected.
  const ACCENT = new THREE.Color('#4da3ff');
  const outlines = { sel: [] as THREE.LineSegments[], hov: [] as THREE.LineSegments[] };
  const lineMat = {
    sel: new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, transparent: true, opacity: 0.95 }),
    hov: new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, transparent: true, opacity: 0.35 }),
  };
  const clearOutline = (which: 'sel' | 'hov') => {
    for (const l of outlines[which]) {
      l.parent?.remove(l);
      l.geometry.dispose();
    }
    outlines[which] = [];
  };
  const outline = (which: 'sel' | 'hov', ref: string | null) => {
    clearOutline(which);
    const obj = ref ? c.partObj.get(ref) : undefined;
    if (!obj) return;
    obj.traverse((n) => {
      // Instanced legs would outline a single leg at the origin; the body says enough.
      if (!(n instanceof THREE.Mesh) || n instanceof THREE.InstancedMesh || !n.visible) return;
      const l = new THREE.LineSegments(new THREE.EdgesGeometry(n.geometry, 30), lineMat[which]);
      l.renderOrder = 10;
      l.raycast = () => {};
      n.add(l);
      outlines[which].push(l);
    });
  };
  let selectedRef: string | null = null;
  let hoveredRef: string | null = null;
  const setSelected = (ref: string | null) => {
    // Every store change calls this; re-outlining an unchanged selection would
    // throw away and rebuild its edge geometry for nothing. rebuild() clears
    // the outline first, so its re-apply still goes through.
    if (ref === selectedRef && (ref === null || outlines.sel.length > 0)) return;
    selectedRef = ref;
    outline('sel', ref);
    if (hoveredRef === ref) clearOutline('hov');
  };
  const setHovered = (ref: string | null) => {
    if (ref === hoveredRef) return;
    hoveredRef = ref;
    outline('hov', ref && ref !== selectedRef ? ref : null);
  };

  // ---------- drag feedback ----------
  const nudge = (ref: string, dx: number, dy: number) => {
    const obj = c.partObj.get(ref);
    if (obj) obj.position.set(dx, 0, dy);
  };
  const tintGeo = new THREE.PlaneGeometry(9, 9).rotateX(-Math.PI / 2);
  const tintMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false });
  // Its own matrix: the sockets' m4 lives inside build().
  const tintM4 = new THREE.Matrix4();
  const TINT_MAX = 128;
  const tintMesh = new THREE.InstancedMesh(tintGeo, tintMat, TINT_MAX);
  tintMesh.count = 0;
  // Created empty, three would cache an empty bounding sphere at the origin
  // and cull the tints whenever the origin is off screen.
  tintMesh.frustumCulled = false;
  tintMesh.renderOrder = 5;
  tintMesh.raycast = () => {};
  scene.add(tintMesh);
  const TONE = { ok: new THREE.Color('#3ecf6e'), join: new THREE.Color('#f5a524'), bad: new THREE.Color('#ef4444') };
  const setStripTint = (tints: Tint[]) => {
    let i = 0;
    for (const t of tints) {
      // A strip leg lights all five holes it joins; a rail leg lights its own.
      const rows = isRail(t.hole.row) ? [t.hole.row] : 'abcde'.includes(t.hole.row) ? (['a', 'b', 'c', 'd', 'e'] as const) : (['f', 'g', 'h', 'i', 'j'] as const);
      for (const row of rows) {
        if (i >= TINT_MAX || t.hole.col < 1 || t.hole.col > c.doc.board.cols) break;
        const h = { col: t.hole.col, row } as Hole;
        tintM4.makeTranslation(holeX(h), TOP + 0.3, holeZ(h));
        tintMesh.setMatrixAt(i, tintM4);
        tintMesh.setColorAt(i, TONE[t.tone]);
        i++;
      }
    }
    tintMesh.count = i;
    tintMesh.instanceMatrix.needsUpdate = true;
    if (tintMesh.instanceColor) tintMesh.instanceColor.needsUpdate = true;
  };

  // ---------- where a part is on screen ----------
  const box = new THREE.Box3();
  const tmp = new THREE.Vector3();
  const project = (x: number, y: number, z: number) => {
    tmp.set(x, y, z).project(camera);
    const rect = dom.getBoundingClientRect();
    return { x: ((tmp.x + 1) / 2) * rect.width, y: ((1 - tmp.y) / 2) * rect.height, visible: tmp.z < 1 };
  };
  const anchor = (ref: string) => {
    const obj = c.partObj.get(ref);
    if (!obj) return null;
    box.setFromObject(obj);
    return project((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
  };
  /** Halfway along a jumper, measured along it. */
  const wireAnchor = (index: number) => {
    const line = c.lines[index];
    if (!line || line.length < 2) return null;
    const lens = line.slice(1).map((p, i) => Math.hypot(p[0] - line[i][0], p[1] - line[i][1], p[2] - line[i][2]));
    let left = lens.reduce((s, l) => s + l, 0) / 2;
    for (let i = 0; i < lens.length; i++) {
      if (left <= lens[i] || i === lens.length - 1) {
        const k = lens[i] ? Math.min(1, left / lens[i]) : 0;
        const [p, q] = [line[i], line[i + 1]];
        return project(p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k + WIRE_R, p[2] + (q[2] - p[2]) * k);
      }
      left -= lens[i];
    }
    return null;
  };

  // ---------- a selected jumper ----------
  // An accent line along the top of the wire, drawn over everything. A tube
  // is smooth all round, so an EdgesGeometry outline would find nothing.
  const wireLineMat = new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, transparent: true, opacity: 0.95 });
  let wireLine: THREE.Line | null = null;
  let selectedWire: number | null = null;
  const setWireSelected = (index: number | null) => {
    selectedWire = index;
    if (wireLine) {
      scene.remove(wireLine);
      wireLine.geometry.dispose();
      wireLine = null;
    }
    const line = index === null ? undefined : c.lines[index];
    if (!line) return;
    wireLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(line.map(([x, y, z]) => new THREE.Vector3(x, y + WIRE_R + 0.6, z))), wireLineMat);
    wireLine.renderOrder = 10;
    wireLine.raycast = () => {};
    scene.add(wireLine);
  };

  const badMat = new THREE.MeshStandardMaterial({ color: '#ef4444', emissive: '#7f1d1d', roughness: 0.4 });
  const setWirePreview = (index: number, plan: PlanPoint[] | null, bad = false) => {
    const shape = c.shapes[index];
    const route = c.routes[index];
    if (!shape || !route) return;
    // While dragging, the wire lies flat: humps come back with the real route.
    reshapeWire(c.kit, shape, plan ?? route.plan, plan ? [] : route.lifts, shape.base);
    shape.jacket.material = plan && bad ? badMat : (shape.jacket.userData.rest as THREE.Material);
    c.lines[index] = shape.line;
    if (selectedWire === index) setWireSelected(index);
  };

  // ---------- handles ----------
  // Discs floating just above the wires, on their own pick layer, drawn over
  // everything so a handle under a part can still be found.
  const HANDLE_LAYER = 4;
  const HANDLE_Y = TOP + 2 * WIRE_R + 1.5;
  const handleGeo = { segment: new THREE.CircleGeometry(5, 20).rotateX(-Math.PI / 2), bend: new THREE.CircleGeometry(3.6, 16).rotateX(-Math.PI / 2) };
  const handleMat = new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  const handlePicked = new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false, side: THREE.DoubleSide });
  const handleGroup = new THREE.Group();
  scene.add(handleGroup);
  const setHandles = (list: Handle[], selectedBend: number | null = null) => {
    handleGroup.clear();
    for (const h of list) {
      const m = new THREE.Mesh(handleGeo[h.kind], h.kind === 'bend' && h.index === selectedBend ? handlePicked : handleMat);
      m.position.set(h.at[0], HANDLE_Y, h.at[1]);
      m.renderOrder = 12;
      m.userData.handle = `${h.kind}:${h.index}`;
      m.layers.enable(HANDLE_LAYER);
      handleGroup.add(m);
    }
    // Picked before the next frame is drawn (a click right after a save), so
    // the world matrices cannot wait for the render to bring them up to date.
    handleGroup.updateMatrixWorld(true);
  };
  const pickHandle = (e: { clientX: number; clientY: number }) => {
    toNdc(e);
    ray.layers.set(HANDLE_LAYER);
    const hit = ray.intersectObjects(handleGroup.children, false)[0];
    if (!hit) return null;
    const [kind, index] = (hit.object.userData.handle as string).split(':');
    return { kind: kind as 'segment' | 'bend', index: Number(index) };
  };

  // ---------- focus ----------
  let glide: { from: THREE.Vector3; to: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; t0: number } | null = null;
  /** Glide to frame whatever `box` holds. */
  const glideToBox = () => {
    const f = frameBox({ min: box.min.toArray(), max: box.max.toArray() }, camera.fov, camera.aspect, 1.6);
    const toT = new THREE.Vector3(...f.target);
    // Keep the current viewing direction, only closer.
    const dir = camera.position.clone().sub(controls.target).normalize();
    glide = { from: camera.position.clone(), to: toT.clone().addScaledVector(dir, f.distance), fromT: controls.target.clone(), toT, t0: performance.now() };
  };
  const focus = (ref: string) => {
    const obj = c.partObj.get(ref);
    if (!obj || fly.active) return;
    box.setFromObject(obj);
    glideToBox();
  };
  // A jumper's box is its centre line's, grown by the jacket's radius.
  const focusWire = (index: number) => {
    const line = c.lines[index];
    if (!line?.length || fly.active) return;
    box.makeEmpty();
    for (const [x, y, z] of line) box.expandByPoint(new THREE.Vector3(x, y, z));
    box.expandByScalar(WIRE_R);
    glideToBox();
  };
  // Any orbit input takes the camera back from a glide in progress.
  const stopGlide = () => (glide = null);
  controls.addEventListener('start', stopGlide);

  const frameFns = new Set<() => void>();

  // ---------- orbit hand-off ----------
  // The editor turns orbit off while it owns a drag, and with it the click
  // and hover handling below, which would otherwise fight the drag.
  const setOrbit = (on: boolean) => {
    orbitOn = on;
    if (!fly.active) controls.enabled = on;
  };

  let press: { x: number; y: number; t: number } | null = null;
  const onDown = (e: PointerEvent) => {
    if (e.button === 0) press = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const onUp = (e: PointerEvent) => {
    const start = press;
    press = null;
    if (!start || e.button !== 0 || !orbitOn) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4 || performance.now() - start.t > 600) return;
    const hit = pick(e);
    if (hit?.kind === 'switch') opts.onToggle?.(hit.key);
    // Parts are the workspace's business; only a jacket or empty board follows or releases a net here.
    else if (hit?.kind !== 'part') opts.onSelectNet?.(hit?.kind === 'wire' ? hit.net : null);
  };
  const onMove = (e: PointerEvent) => {
    // Mid-drag the camera is moving, and flying has no cursor to hit test with.
    if (press || fly.active || !orbitOn) return;
    const hit = pick(e);
    dom.style.cursor = hit?.kind === 'switch' || hit?.kind === 'part' ? 'pointer' : '';
    setHoveredNet(hit?.kind === 'wire' ? hit.net : null);
  };
  const onLeave = () => setHoveredNet(null);
  // Losing the context loses every buffer: nothing here can be drawn again,
  // so the owner is told and takes the board down.
  const onLost = () => opts.onContextLost?.();
  dom.addEventListener('webglcontextlost', onLost);
  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerleave', onLeave);

  // ---------- live state ----------
  // Two sources, one painting pass: the analog solver when a frame exists,
  // and the boolean simulator's on/off before anything has been solved.
  let frame: AnalogState | null = null;
  let booleanLeds: Record<string, boolean> = {};
  const paintLeds = () => {
    for (const [ref, l] of c.leds) {
      const brightness = frame ? Math.min(Math.max(frame.brightness[ref] ?? 0, 0), 1) : booleanLeds[ref] ? 1 : 0;
      const over = frame?.overdrive[ref] ?? 0;
      // Same perceptual curve the flat board uses, so the two agree.
      const k = Math.pow(brightness, 0.45);
      // Kept deliberately below the level that looks brightest on its own. The
      // tone mapping curve desaturates as it clips, so an epoxy driven hard
      // enough to blow out turns a red LED salmon and every colour of LED ends
      // up the same warm white. The body holds its hue here and the corona
      // carries the brightness instead, which is the division of labour a real
      // one has: a coloured lens with a glare around it.
      l.material.emissiveIntensity = k * 1.5 + over * 1.4;
      // A dark LED is a shiny lens and should mirror the room. A lit one is
      // dominated by its own output, and leaving the reflection at full
      // strength on top of that is what turns a red LED into a pale salmon
      // lump: the room is white, and white added to red is pink.
      l.material.envMapIntensity = 1 - 0.7 * Math.min(1, k);
      // Only the die itself burns towards white, and only part way.
      l.core.color.set(l.spec.light).lerp(WHITE, Math.min(0.55, k * 0.5 + over * 0.3));
      l.core.opacity = Math.min(1, k * 1.2);
      // The die is small and close, so the spill needs real power behind it.
      l.lamp.intensity = (k * 2600 + over * 1200) * l.spec.gain;
      // Brightness past white is spent on area instead: the corona grows and
      // strengthens with the drive, and vanishes completely when the LED is
      // dark so an unlit board carries no glow at all.
      const halo = Math.min(1, k * 0.95 + over * 0.6);
      l.glow.material.opacity = halo;
      const size = (3 + k * 12 + over * 7) * MM * l.spec.gain;
      l.glow.scale.set(size, size, 1);
      l.glow.visible = halo > 0.01;
    }
  };
  // Kept, like the LEDs' state, so a rebuilt board comes back with its
  // switches where they were and its displays still lit.
  let switchState: Record<string, boolean> = {};
  let segmentState: Record<string, Record<string, boolean>> = {};
  const paintBoard = () => {
    for (const w of c.ways) w.slider.position.z = switchState[w.key] ? w.onZ : w.offZ;
    // The displays come only from the boolean simulator: the analog solver
    // does not model the seven-segment package.
    for (const [ref, d] of c.displays) for (const [seg, mat] of Object.entries(d.segments)) mat.emissiveIntensity = segmentState[ref]?.[seg] ? 2.2 : 0;
    paintLeds();
  };

  // ---------- drop ghost ----------
  const ghostMat = {
    ok: new THREE.MeshStandardMaterial({ color: '#4ade80', transparent: true, opacity: 0.45, depthWrite: false }),
    bad: new THREE.MeshStandardMaterial({ color: '#f87171', transparent: true, opacity: 0.45, depthWrite: false }),
  };
  let ghost: THREE.Group | null = null;
  const clearGhost = () => {
    if (!ghost) return;
    scene.remove(ghost);
    ghost.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    ghost = null;
  };
  function setGhost(g: { holes: Hole[]; footprint: 'lead2' | 'dip' | 'other'; ok: boolean } | null) {
    clearGhost();
    if (!g || !g.holes.length) return;
    ghost = new THREE.Group();
    const mat = g.ok ? ghostMat.ok : ghostMat.bad;
    const pts = g.holes.map((h) => at(h, TOP + 6));
    if (g.footprint === 'lead2' && pts.length === 2) {
      const len = pts[0].distanceTo(pts[1]);
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(6, Math.max(1, len - 12), 4, 12), mat);
      body.position.copy(pts[0]).add(pts[1]).multiplyScalar(0.5);
      body.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pts[1].clone().sub(pts[0]).normalize());
      ghost.add(body);
    } else if (g.footprint === 'dip') {
      const box = new THREE.Box3().setFromPoints(pts);
      const size = box.getSize(new THREE.Vector3());
      const body = new THREE.Mesh(new THREE.BoxGeometry(size.x + 12, 10, size.z + 6), mat);
      body.position.copy(box.getCenter(new THREE.Vector3())).setY(TOP + 8);
      ghost.add(body);
    } else
      for (const p of pts) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(5, 12, 8), mat);
        s.position.copy(p);
        ghost.add(s);
      }
    scene.add(ghost);
  }

  // ---------- rebuilding after an edit ----------
  const rebuild = (next: LayoutDoc, style?: 'arc' | 'orthogonal') => {
    if (style) wireStyle = style;
    clearGhost();
    scene.remove(c.root);
    c.kit.dispose();
    // The Show filter's see-through copies belong to the old materials.
    for (const g of glassOf.values()) g.dispose();
    glassOf.clear();
    c = build(next);
    scene.add(c.root);
    // Selection outlines hang off the old meshes; rebuild them on the new ones.
    const sel = selectedRef;
    const hov = hoveredRef;
    selectedRef = hoveredRef = null;
    clearOutline('sel');
    clearOutline('hov');
    if (sel && c.partObj.has(sel)) setSelected(sel);
    if (hov && c.partObj.has(hov)) setHovered(hov);
    // The selection line follows the wire onto its new shape. Handles are the
    // wire editor's; it has already placed them for the new doc.
    setWireSelected(selectedWire !== null && selectedWire < c.lines.length ? selectedWire : null);
    // The held highlight hides wires by visibility, which the new wires do not
    // have yet; applying it again also repaints the nets.
    setHighlight(held);
    paintBoard();
  };

  // ---------- loop ----------
  let raf = 0;
  let alive = true;
  let last = performance.now();
  const render = () => {
    if (!alive) return;
    const now = performance.now();
    // Clamped, so a tab that was in the background for a minute does not come
    // back with one enormous step and throw the camera off the board.
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (fly.active) fly.update(dt);
    else controls.update();
    if (glide && !fly.active) {
      const k = easeOutCubic(Math.min(1, (now - glide.t0) / 400));
      camera.position.lerpVectors(glide.from, glide.to, k);
      controls.target.lerpVectors(glide.fromT, glide.toT, k);
      if (k >= 1) glide = null;
    }
    renderer.render(scene, camera);
    for (const fn of frameFns) fn();
    raf = requestAnimationFrame(render);
  };

  const resize = () => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  const resetView = () => {
    // Coming home means orbiting the board again, whatever the camera was
    // doing a moment ago. Home is over the board as it is now, which an edit
    // may have widened since mount.
    setFly(false);
    glide = null;
    const x = centreOf(c.doc);
    const z = depthOf(c.doc) / 2;
    camera.position.set(x, 620, z + 520);
    camera.lookAt(x, TOP, z);
    controls.target.set(x, TOP - BOARD_THICK / 2, z);
    controls.update();
  };

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resetView();
  resize();
  render();

  return {
    resize,
    resetView,
    setFly,
    get flying() {
      return fly.active;
    },
    setState(s) {
      frame = s;
      paintLeds();
    },
    setHighlight,
    setHover: setHoveredNet,
    setBoard(switches, boolLeds, segments = {}) {
      switchState = switches;
      booleanLeds = boolLeds;
      segmentState = segments;
      paintBoard();
    },
    rebuild,
    pick,
    boardPoint,
    setSelected,
    setHovered,
    nudge,
    setStripTint,
    setGhost,
    anchor,
    focus,
    focusWire,
    onFrame: (fn) => (frameFns.add(fn), () => frameFns.delete(fn)),
    dom,
    setOrbit,
    setWireSelected,
    setWirePreview,
    setHandles,
    pickHandle,
    project,
    wireAnchor,
    // Internal, for the e2e hook: how many strip tints are showing.
    _tintCount: () => tintMesh.count,
    // Internal, for the e2e hook: how many meshes the drop ghost is made of.
    _ghostCount: () => ghost?.children.length ?? 0,
    // Internal, for the e2e hook: the highest point of any square jumper's jacket.
    _wireTop: () =>
      c.shapes.reduce((top, s) => {
        if (!s) return top;
        s.jacket.geometry.computeBoundingBox();
        return Math.max(top, s.jacket.geometry.boundingBox!.max.y);
      }, -Infinity),
    // Internal, for the e2e hook: what a GPU reset does.
    _loseContext: () => renderer.forceContextLoss(),
    // Internal, for the e2e hook: the handles on screen (CSS px, page coordinates).
    _handles: () => {
      const rect = dom.getBoundingClientRect();
      return handleGroup.children.map((m) => {
        const [kind, index] = (m.userData.handle as string).split(':');
        const at = project(m.position.x, m.position.y, m.position.z);
        return { kind: kind as 'segment' | 'bend', index: Number(index), x: rect.left + at.x, y: rect.top + at.y };
      });
    },
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      dom.removeEventListener('webglcontextlost', onLost);
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerleave', onLeave);
      controls.removeEventListener('start', stopGlide);
      frameFns.clear();
      fly.dispose();
      controls.dispose();
      envTarget.dispose();
      for (const g of glassOf.values()) g.dispose();
      clearOutline('sel');
      clearOutline('hov');
      lineMat.sel.dispose();
      lineMat.hov.dispose();
      setWireSelected(null);
      wireLineMat.dispose();
      badMat.dispose();
      handleGroup.clear();
      handleGeo.segment.dispose();
      handleGeo.bend.dispose();
      handleMat.dispose();
      handlePicked.dispose();
      tintGeo.dispose();
      tintMat.dispose();
      tintMesh.dispose();
      clearGhost();
      ghostMat.ok.dispose();
      ghostMat.bad.dispose();
      c.kit.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
