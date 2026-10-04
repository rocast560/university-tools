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
import type { Hole } from '../src/layout/types.ts';
import type { LayoutDoc } from '../src/pipeline.ts';
import { liftCrossings, type Span } from '../src/render/altitude.ts';
import type { Highlight } from '../src/render/index.ts';
import { P, ROWY, tierCols, tierCount, TIER_PITCH, tierShift, X0 } from '../src/render/geometry.ts';
import { wireControls } from '../src/render/routing.ts';
import { wirePolylines } from '../src/render/ortho.ts';
import type { AnalogState } from '../src/sim/analog/simulator.ts';
import { at, BOARD_THICK, buildPackage, buildPart, grainMap, holeX, holeZ, Kit, setHoleBoard, MM, routeWire, TOP, tube, WIRE_CLEARANCE, WIRE_END_Y, type LedLamp, type Obstacle, type SevenSegLamp, type Way } from './board3d-parts.ts';
import { flyControls } from './fly.ts';

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
  for (let i = 0; i < 26000; i++) {
    const a = Math.random() * 0.05;
    g.fillStyle = Math.random() > 0.5 ? `rgba(120,112,92,${a})` : `rgba(255,252,242,${a})`;
    g.fillRect(Math.random() * width, Math.random() * depth, 1.4, 1.4);
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
}

export function mount3d(container: HTMLElement, doc: LayoutDoc, opts: Board3DOptions = {}): Board3D {
  setHoleBoard(doc.board);
  const cols = doc.board.cols;
  const tiers = tierCount(doc.board);
  const width = X0 + (tierCols(doc.board) - 1) * P + X0;
  /** One board's depth; stacked boards sit one TIER_PITCH apart. */
  const boardDepth = 350;
  const depth = boardDepth + (tiers - 1) * TIER_PITCH;
  const cx = width / 2;
  const cz = depth / 2;

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
  const home = v(cx, 620, cz + 520);

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
    controls.enabled = true;
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
  // One ortho frustum wide enough for the whole board, whatever its size.
  const reach = Math.max(width, depth) * 0.8;
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

  const kit = new Kit();
  const M = kit.M;

  const bump = kit.keep(topBump(doc, width, boardDepth));
  const topMats = Array.from({ length: tiers }, (_, k) => kit.std({ map: kit.keep(topTexture(doc, width, boardDepth, k * tierCols(doc.board))), bumpMap: bump, bumpScale: 1.6, roughness: 0.8, metalness: 0.02 }));

  const root = new THREE.Group();
  scene.add(root);

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
  const holes: Hole[] = [];
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const;
  for (const row of rows) for (let c = 1; c <= cols; c++) holes.push({ col: c, row });
  for (const row of ['T+', 'T-', 'B-', 'B+'] as const) for (let c = 1; c <= cols; c++) if (c % doc.board.railGapEvery !== 0) holes.push({ col: c, row });
  const socket = new THREE.InstancedMesh(kit.keep(new THREE.BoxGeometry(6.4, 7, 6.4)), M.socket, holes.length);
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
  const collectPickable = (o: THREE.Object3D) => o.traverse((n) => { if (typeof n.userData.switchKey === 'string') pickable.push(n); });

  for (const pkg of doc.packages) {
    const built = buildPackage(kit, pkg, doc);
    root.add(built.object);
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
  const square = opts.wireStyle === 'orthogonal';
  const plans = square ? wirePolylines(doc.wires, doc.packages, doc.board) : [];
  // Square runs cross each other at right angles, so each wire takes the
  // lowest level none of the wires it crosses is using: a graph colouring,
  // greedy in wire order, which is enough for a breadboard.
  const levels: number[] = new Array(doc.wires.length).fill(0);
  if (square) {
    const segs = plans.map((pts) => pts.slice(0, -1).map((p, k) => [p, pts[k + 1]] as const));
    const crosses = (i: number, j: number) =>
      segs[i].some(([a1, a2]) =>
        segs[j].some(([b1, b2]) => {
          const ah = a1[1] === a2[1];
          const bh = b1[1] === b2[1];
          if (ah === bh) return false;
          const [h1, h2, v1, v2] = ah ? [a1, a2, b1, b2] : [b1, b2, a1, a2];
          const [hx0, hx1] = [Math.min(h1[0], h2[0]), Math.max(h1[0], h2[0])];
          const [vz0, vz1] = [Math.min(v1[1], v2[1]), Math.max(v1[1], v2[1])];
          return v1[0] > hx0 && v1[0] < hx1 && h1[1] > vz0 && h1[1] < vz1;
        }),
      );
    for (let i = 0; i < doc.wires.length; i++) {
      const used = new Set<number>();
      for (let j = 0; j < i; j++) if (crosses(i, j)) used.add(levels[j]);
      while (used.has(levels[i])) levels[i]++;
    }
  }
  for (const [i, w] of doc.wires.entries()) {
    const a = at(w.a, WIRE_END_Y);
    const b = at(w.b, WIRE_END_Y);
    const length = a.distanceTo(b);
    if (square) {
      // Straight up out of each hole, along the plan at one level, straight
      // down into the other: tinned where it is stripped, jacketed between.
      const plan = plans[i];
      const riseA = endRise(a);
      const riseB = endRise(b);
      let y = Math.max(riseA, riseB, TOP + 10) + levels[i] * 5;
      // Anything the plan passes over has to be cleared too.
      for (const o of obstacles) for (const [px, pz] of plan) if (px >= o.x0 - 2 && px <= o.x1 + 2 && pz >= o.z0 - 2 && pz <= o.z1 + 2) y = Math.max(y, o.top + WIRE_CLEARANCE + levels[i] * 5);
      const objs: THREE.Object3D[] = [];
      const strip = 7;
      const jacket = jacketFor(w.net);
      const add = (m: THREE.Mesh) => {
        root.add(m);
        objs.push(m);
      };
      add(tube(kit, a, a.clone().setY(WIRE_END_Y + strip), 2.1, tinFor(w.net), 8));
      add(tube(kit, b, b.clone().setY(WIRE_END_Y + strip), 2.1, tinFor(w.net), 8));
      const pts: THREE.Vector3[] = [a.clone().setY(WIRE_END_Y + strip), ...plan.map(([px, pz]) => v(px, y, pz)), b.clone().setY(WIRE_END_Y + strip)];
      for (let k = 0; k + 1 < pts.length; k++) {
        const m = tube(kit, pts[k], pts[k + 1], 4, jacket, 10);
        m.userData.net = w.net;
        add(m);
        wirePick.push(m);
        if (k + 2 < pts.length) {
          const corner = kit.mesh(new THREE.SphereGeometry(4, 12, 10), jacket);
          corner.position.copy(pts[k + 1]);
          add(corner);
        }
      }
      wireObjs.push({ net: w.net, objs });
      continue;
    }
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
    root.add(mesh);
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

  // ---------- picking: flick a switch in 3D ----------
  // Clicking is deliberately resolved on pointerup, and only when the pointer
  // barely moved, because the same button orbits the camera. Only the switch
  // objects are raycast, so a drag never pays for hit testing the whole board.
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const dom = renderer.domElement;
  // Switches and jackets in one array, resolved in one cast: a pointer move
  // has to answer both "is this clickable" and "which net is this" and there
  // is no reason to pay for the traversal twice.
  const targets = [...pickable, ...wirePick];
  const probe = (e: PointerEvent): { key: string | null; net: string | null } => {
    const rect = dom.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    for (const hit of ray.intersectObjects(targets, true)) {
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
        if (typeof o.userData.switchKey === 'string') return { key: o.userData.switchKey, net: null };
        if (typeof o.userData.net === 'string') return { key: null, net: o.userData.net };
      }
    }
    return { key: null, net: null };
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
  const paintNets = () => {
    const net = hovered ?? litNet;
    for (const [id, m] of netMat) {
      const base = netColour.get(id)!;
      const tin = tinMat.get(id);
      const faded = !!net && id !== net;
      m.color.copy(base);
      // The lit net carries its own colour as emissive, so it reads as lit
      // rather than merely pale; everything else turns to glass: still there
      // to show where it runs, but the lit net reads through it.
      if (net && !faded) m.emissive.copy(base).multiplyScalar(0.45);
      else m.emissive.setRGB(0, 0, 0);
      fade(m, faded);
      if (tin) fade(tin, faded);
    }
  };
  const setHovered = (net: string | null) => {
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
    for (const part of doc.parts) if (part.id === ref) for (const n of part.nets) nets.add(n);
    for (const po of doc.pinouts) if (po.ref === ref) for (const pin of po.pins) if (pin.net) nets.add(pin.net);
    return nets;
  };
  const setHighlight = (hl: Highlight | null) => {
    const refNets = hl?.ref !== undefined ? netsOfRef(hl.ref) : null;
    const soft = !!hl?.soft && hl.net !== undefined;
    wireObjs.forEach((w, i) => {
      const keep = !hl ? true : hl.wire !== undefined ? i === hl.wire : hl.net !== undefined ? w.net === hl.net : refNets ? refNets.has(w.net) : true;
      // Soft: the rest stays as glass, so the followed net reads in context.
      // Hard: the rest goes, so the run can be traced clean.
      for (const o of w.objs) o.visible = keep || soft;
    });
    litNet = hl?.net ?? (hl?.wire !== undefined ? (doc.wires[hl.wire]?.net ?? null) : null);
    paintNets();
  };

  let press: { x: number; y: number; t: number } | null = null;
  const onDown = (e: PointerEvent) => {
    if (e.button === 0) press = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const onUp = (e: PointerEvent) => {
    const start = press;
    press = null;
    if (!start || e.button !== 0 || (!opts.onToggle && !opts.onSelectNet)) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4 || performance.now() - start.t > 600) return;
    const { key, net } = probe(e);
    if (key) opts.onToggle?.(key);
    else opts.onSelectNet?.(net);
  };
  const onMove = (e: PointerEvent) => {
    // Mid-drag the camera is moving, and flying has no cursor to hit test with.
    if (press || fly.active) return;
    const { key, net } = probe(e);
    dom.style.cursor = key ? 'pointer' : '';
    setHovered(net);
  };
  const onLeave = () => setHovered(null);
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
    for (const [ref, l] of leds) {
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
    renderer.render(scene, camera);
    raf = requestAnimationFrame(render);
  };

  // F is the toggle, and it has to lose to anything the user is typing into.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'f' && e.key !== 'F') return;
    const t = e.target as HTMLElement | null;
    if (t?.isContentEditable || (t && /^(input|textarea|select)$/i.test(t.tagName))) return;
    e.preventDefault();
    setFly(!fly.active);
  };
  document.addEventListener('keydown', onKeyDown);

  const resize = () => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  const resetView = () => {
    // Coming home means orbiting the board again, whatever the camera was
    // doing a moment ago.
    setFly(false);
    camera.position.copy(home);
    camera.lookAt(cx, TOP, cz);
    controls.target.set(cx, TOP - BOARD_THICK / 2, cz);
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
    setState(s) {
      frame = s;
      paintLeds();
    },
    setHighlight,
    setHover: setHovered,
    setBoard(switches, boolLeds, segments = {}) {
      for (const w of ways) w.slider.position.z = switches[w.key] ? w.onZ : w.offZ;
      booleanLeds = boolLeds;
      // The displays come only from the boolean simulator: the analog solver
      // does not model the seven-segment package.
      for (const [ref, d] of displays) for (const [seg, mat] of Object.entries(d.segments)) mat.emissiveIntensity = segments[ref]?.[seg] ? 2.2 : 0;
      paintLeds();
    },
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('keydown', onKeyDown);
      fly.dispose();
      controls.dispose();
      envTarget.dispose();
      kit.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
