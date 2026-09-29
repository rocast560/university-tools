// three.js meshes for a flat jumper, from the numbers wiretube-math.ts works
// out. Kept thin on purpose: everything that can be tested without WebGL
// lives in that module.

import * as THREE from 'three';
import type { Lift, Point } from '../src/render/route3d.ts';
import { WIRE_R } from '../src/render/route3d.ts';
import { TOP, WIRE_END_Y, type Kit } from './board3d-parts.ts';
import { wireShape, type TubeData, type V3 } from './wiretube-math.ts';

/** The tinned core's radius: 22 AWG copper is about 0.64 mm across. */
const CORE_R = 2.1;

export function tubeGeometry(t: TubeData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(t.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(t.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(t.indices, 1));
  g.computeBoundingSphere();
  return g;
}

export interface WireMeshes {
  jacket: THREE.Mesh;
  tin: THREE.Mesh;
  /** The filleted centre line, for the selection line and the card's anchor. */
  line: V3[];
  length: number;
  /** The centre line's height where it lies flat. */
  base: number;
}

const shapeOf = (plan: Point[], lifts: Lift[], base: number) => wireShape(plan, lifts, { base, endY: WIRE_END_Y, top: TOP, radius: WIRE_R, core: CORE_R, sides: 8, coreSides: 6 });

/** A jumper's jacket and bare ends. `base` is the centre line's height where it lies flat. */
export function buildWireMeshes(kit: Kit, plan: Point[], lifts: Lift[], base: number, jacket: THREE.Material, tin: THREE.Material): WireMeshes {
  const s = shapeOf(plan, lifts, base);
  const m = { jacket: kit.mesh(tubeGeometry(s.jacket), jacket), tin: kit.mesh(tubeGeometry(s.tin), tin), line: s.line, length: s.length, base };
  // What the jacket goes back to after a red drag preview.
  m.jacket.userData.rest = jacket;
  return m;
}

/**
 * Give an existing jumper a new shape in place, for the live preview while a
 * handle is dragged: only this wire's buffers are rebuilt, and the old ones
 * are freed at once. The kit keeps the new ones, so a rebuild frees them too.
 */
export function reshapeWire(kit: Kit, m: WireMeshes, plan: Point[], lifts: Lift[], base: number): void {
  const s = shapeOf(plan, lifts, base);
  m.jacket.geometry.dispose();
  m.tin.geometry.dispose();
  m.jacket.geometry = kit.keep(tubeGeometry(s.jacket));
  m.tin.geometry = kit.keep(tubeGeometry(s.tin));
  m.line = s.line;
  m.length = s.length;
}
