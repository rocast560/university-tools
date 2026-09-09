// A real 3D breadboard, built from the same layout the flat board is drawn
// from, so the two can never disagree about what is wired where.
//
// Everything is in the renderer's own units, where one hole pitch is 18 and
// therefore 1 mm is about 7.1. The board is modelled at true thickness, which
// is what makes it read as a physical object once you tip it over.
//
// The budget that keeps it smooth: every hole is one instance of one mesh and
// every chip's pins are another, so the ~900 sockets on a half board cost a
// single draw call rather than nine hundred. Materials are shared, the tone
// map is cheap, and nothing is rebuilt per frame - a running simulation only
// writes emissive intensity on the LED materials it already has.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Hole, PlacedPart } from '../src/layout/types.ts';
import type { LayoutDoc } from '../src/pipeline.ts';
import { P, ROWY, X0 } from '../src/render/geometry.ts';
import { ledSpec, ledSpecFor } from '../src/parts/led.ts';
import type { AnalogState } from '../src/sim/analog/simulator.ts';

/** 1 mm in board units: one 0.1 inch pitch is 18 units. */
const MM = P / 2.54;
const THICK = 9 * MM;
/** Top face sits at y = 0; the slab hangs below it. */
const TOP = 0;

/**
 * The printed top surface, drawn once into a canvas: the moulded grain, the
 * rail stripes, and the row letters and column numbers a real board carries.
 * One texture is far cheaper than geometry for any of it, and it is what makes
 * the board read as a manufactured object rather than a slab.
 */
function topTexture(doc: LayoutDoc, width: number, depth: number): THREE.CanvasTexture {
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

  const cols = doc.board.cols;
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

  g.fillStyle = '#6b6455';
  g.font = '11px ui-monospace, monospace';
  g.textAlign = 'center';
  for (const row of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const) {
    g.fillText(row, X0 - 20, ROWY[row] + 4);
    g.fillText(row, X0 + (cols - 1) * P + 20, ROWY[row] + 4);
  }
  g.font = '10px ui-monospace, monospace';
  for (let c = 1; c <= cols; c++) {
    if (c !== 1 && c % 5 !== 0) continue;
    g.fillText(String(c), X0 + (c - 1) * P, ROWY.a - 12);
    g.fillText(String(c), X0 + (c - 1) * P, ROWY.j + 18);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const holeX = (h: Hole) => X0 + (h.col - 1) * P;
const holeZ = (h: Hole) => ROWY[h.row];

export interface Board3D {
  dispose(): void;
  setState(s: AnalogState | null): void;
  resize(): void;
  resetView(): void;
}

export function mount3d(container: HTMLElement, doc: LayoutDoc): Board3D {
  const cols = doc.board.cols;
  const width = X0 + (cols - 1) * P + X0;
  const depth = 350;
  const cx = width / 2;
  const cz = depth / 2;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  // Capping the pixel ratio is the single biggest lever on a high-DPI screen:
  // rendering at 3x costs nine times the fragments for no visible gain here.
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e9e5dc');

  const camera = new THREE.PerspectiveCamera(38, 1, 5, 8000);
  const home = v(cx, 620, cz + 520);

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
  controls.target.set(cx, TOP - THICK / 2, cz);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8676, 1.15));
  const key = new THREE.DirectionalLight(0xfff6e8, 1.5);
  key.position.set(cx - 500, 900, cz - 300);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.45);
  fill.position.set(cx + 600, 300, cz + 700);
  scene.add(fill);
  // Being able to look at the underside is the point of this view, so it has
  // to be lit. Without this the board goes black the moment you tip past level.
  const under = new THREE.DirectionalLight(0xfff2e0, 0.75);
  under.position.set(cx + 200, -800, cz + 200);
  scene.add(under);

  const bin: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    bin.push(x);
    return x;
  };

  const mat = (o: THREE.MeshStandardMaterialParameters) => keep(new THREE.MeshStandardMaterial(o));
  const M = {
    board: mat({ color: '#e6e0cf', roughness: 0.82, metalness: 0.02 }),
    // Real boards have a peel-off adhesive backing, which is what you see
    // from below.
    backing: mat({ color: '#d8cdb4', roughness: 0.95, metalness: 0 }),
    channel: mat({ color: '#cfc8b4', roughness: 0.9 }),
    socket: mat({ color: '#1b1e23', roughness: 0.65 }),
    metal: mat({ color: '#b9bfc8', roughness: 0.28, metalness: 0.92 }),
    chip: mat({ color: '#2b2d33', roughness: 0.55 }),
    body: mat({ color: '#e8d5a3', roughness: 0.7 }),
    dark: mat({ color: '#2f333a', roughness: 0.6 }),
  };

  const top = keep(topTexture(doc, width, depth));
  const topMat = mat({ map: top, roughness: 0.86, metalness: 0.02 });

  const root = new THREE.Group();
  scene.add(root);

  // ---------- slab and channel ----------
  // BoxGeometry takes one material per face: +x -x +y -y +z -z.
  const slab = new THREE.Mesh(keep(new THREE.BoxGeometry(width, THICK, depth)), [M.board, M.board, topMat, M.backing, M.board, M.board]);
  slab.position.set(cx, TOP - THICK / 2, cz);
  root.add(slab);

  const channel = new THREE.Mesh(keep(new THREE.BoxGeometry(width - 40, THICK * 0.42, 12)), M.channel);
  channel.position.set(cx, TOP - THICK * 0.21 + 0.2, (ROWY.e + ROWY.f) / 2);
  root.add(channel);

  // ---------- sockets: every hole in one draw call ----------
  const holes: Hole[] = [];
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const;
  for (const row of rows) for (let c = 1; c <= cols; c++) holes.push({ col: c, row });
  for (const row of ['T+', 'T-', 'B-', 'B+'] as const) for (let c = 1; c <= cols; c++) if (c % doc.board.railGapEvery !== 0) holes.push({ col: c, row });
  const socket = new THREE.InstancedMesh(keep(new THREE.BoxGeometry(6.2, 5, 6.2)), M.socket, holes.length);
  const m4 = new THREE.Matrix4();
  holes.forEach((h, i) => socket.setMatrixAt(i, m4.makeTranslation(holeX(h), TOP - 2.2, holeZ(h))));
  socket.instanceMatrix.needsUpdate = true;
  root.add(socket);

  // ---------- packages ----------
  for (const pkg of doc.packages) {
    const w = ((pkg.pins / 2) - 1) * P + 14;
    const d = ROWY.f - ROWY.e + 14;
    const x = X0 + (pkg.col0 - 1) * P + (((pkg.pins / 2) - 1) * P) / 2;
    const z = (ROWY.e + ROWY.f) / 2;
    const h = 7 * MM * 0.5;
    const body = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), M.chip);
    body.position.set(x, TOP + h / 2 + 2, z);
    root.add(body);
    // Pin 1 notch, and the pins themselves as one instanced mesh.
    const notch = new THREE.Mesh(keep(new THREE.CylinderGeometry(3, 3, h + 0.4, 12)), M.dark);
    notch.position.set(x - w / 2, TOP + h / 2 + 2, z);
    root.add(notch);
    const pins = new THREE.InstancedMesh(keep(new THREE.BoxGeometry(1.8, 6, 3)), M.metal, pkg.pins);
    for (let i = 0; i < pkg.pins; i++) {
      const half = i < pkg.pins / 2;
      const idx = half ? i : pkg.pins - 1 - i;
      pins.setMatrixAt(i, m4.makeTranslation(X0 + (pkg.col0 - 1 + idx) * P, TOP - 1, half ? ROWY.f : ROWY.e));
    }
    pins.instanceMatrix.needsUpdate = true;
    root.add(pins);
  }

  // ---------- two- and three-lead parts ----------
  const ledMats = new Map<string, THREE.MeshStandardMaterial>();
  for (const part of doc.parts) addPart(part);

  function leadTube(a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material) {
    const len = a.distanceTo(b);
    const mesh = new THREE.Mesh(keep(new THREE.CylinderGeometry(r, r, len, 8)), m);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(v(0, 1, 0), b.clone().sub(a).normalize());
    return mesh;
  }

  function addPart(part: PlacedPart) {
    const pts = part.holes.map((h) => v(holeX(h), TOP, holeZ(h)));
    if (part.kind !== 'lead2' || pts.length < 2) {
      // Three-leg parts stand up as a simple body; enough to read the shape.
      const box = new THREE.Mesh(keep(new THREE.BoxGeometry(part.holes.length * P * 0.7, 22, 10)), M.dark);
      const mid = pts.reduce((acc, p) => acc.add(p), v(0, 0, 0)).multiplyScalar(1 / pts.length);
      box.position.set(mid.x, TOP + 11, mid.z);
      root.add(box);
      return;
    }
    const [a, b] = pts;
    const lift = part.style === 'LED' ? 16 : 9;
    const ay = a.clone().setY(TOP + lift);
    const by = b.clone().setY(TOP + lift);
    root.add(leadTube(a, ay, 1.1, M.metal));
    root.add(leadTube(b, by, 1.1, M.metal));
    const mid = ay.clone().add(by).multiplyScalar(0.5);

    if (part.style === 'LED') {
      const spec = doc.ledColors?.[part.id] ? ledSpecFor(doc.ledColors[part.id]) : ledSpec(part.value || 'LED');
      const m = keep(new THREE.MeshStandardMaterial({ color: spec.body, roughness: 0.22, metalness: 0.02, transparent: true, opacity: 0.92, emissive: new THREE.Color(spec.light), emissiveIntensity: 0 }));
      ledMats.set(part.id, m);
      const dome = new THREE.Mesh(keep(new THREE.SphereGeometry(9, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2)), m);
      dome.position.set(mid.x, TOP + lift + 6, mid.z);
      root.add(dome);
      const barrel = new THREE.Mesh(keep(new THREE.CylinderGeometry(9, 9, 12, 20)), m);
      barrel.position.set(mid.x, TOP + lift, mid.z);
      root.add(barrel);
      const flange = new THREE.Mesh(keep(new THREE.CylinderGeometry(10.4, 10.4, 2.2, 20)), M.body);
      flange.position.set(mid.x, TOP + lift - 6, mid.z);
      root.add(flange);
      return;
    }
    if (part.style === 'R') {
      const body = leadTube(ay.clone().lerp(by, 0.2), ay.clone().lerp(by, 0.8), 4.2, M.body);
      root.add(body);
      root.add(leadTube(ay, by, 1.1, M.metal));
      for (const [t, colour] of [[0.34, '#B4232C'], [0.5, '#3A3D44'], [0.66, '#E3B505']] as [number, string][]) {
        const band = leadTube(ay.clone().lerp(by, t - 0.03), ay.clone().lerp(by, t + 0.03), 4.4, mat({ color: colour, roughness: 0.6 }));
        root.add(band);
      }
      return;
    }
    root.add(leadTube(ay, by, 1.1, M.metal));
    const body = leadTube(ay.clone().lerp(by, 0.25), ay.clone().lerp(by, 0.75), 4, part.style === 'SW' || part.style === 'BTN' ? M.dark : M.body);
    root.add(body);
  }

  // ---------- jumper wires ----------
  // A real jumper bows above the board, which is what separates one crossing
  // from another once you are looking along the surface.
  for (const [i, w] of doc.wires.entries()) {
    const colour = doc.nets[w.net]?.color ?? '#444';
    const a = v(holeX(w.a), TOP, holeZ(w.a));
    const b = v(holeX(w.b), TOP, holeZ(w.b));
    const span = a.distanceTo(b);
    const arch = Math.min(6 + span * 0.16, 46) + (i % 3) * 2.5;
    const curve = new THREE.QuadraticBezierCurve3(a, a.clone().add(b).multiplyScalar(0.5).setY(TOP + arch), b);
    const jacket = new THREE.Mesh(keep(new THREE.TubeGeometry(curve, Math.max(10, Math.round(span / 12)), 2.1, 7, false)), mat({ color: colour, roughness: 0.45 }));
    root.add(jacket);
    // The stripped ends: a short bare run into each hole.
    for (const end of [a, b]) root.add(leadTube(end, end.clone().setY(TOP + 7), 1.15, M.metal));
  }

  // ---------- loop ----------
  let raf = 0;
  let alive = true;
  const render = () => {
    if (!alive) return;
    controls.update();
    renderer.render(scene, camera);
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
    camera.position.copy(home);
    controls.target.set(cx, TOP - THICK / 2, cz);
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
    setState(s) {
      for (const [ref, m] of ledMats) {
        const brightness = s?.brightness[ref] ?? 0;
        const over = s?.overdrive[ref] ?? 0;
        // Same perceptual curve the flat board uses, so the two agree.
        m.emissiveIntensity = Math.pow(Math.min(Math.max(brightness, 0), 1), 0.45) * 2.6 + over * 2;
      }
    },
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      for (const x of bin) x.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
