// Flying the camera through the board, as opposed to orbiting around it.
//
// Orbit is the right default: the board is the subject, and spinning it is how
// you look at a thing. But orbit always points at one pivot, so getting the
// camera down between two chips to see which hole a lead actually lands in
// means fighting it. Fly mode drops that constraint - the camera goes where
// you steer it and looks where you point it, the way it works in every 3D
// tool - and orbit is one key away again.
//
// Nothing here allocates per frame and nothing here renders: the owner calls
// update() with a delta and gets the camera moved.

import * as THREE from 'three';

/** Units per second on the ground. The board is about a thousand across. */
const SPEED = 300;
/** Held shift. Enough to cross the board in a second, not enough to overshoot. */
const BOOST = 3.2;
/** Radians of turn per pixel of mouse travel. */
const LOOK = 0.0022;
/** How close to straight up or down the camera may point. */
const PITCH_LIMIT = Math.PI / 2 - 0.02;
/** How quickly the camera comes up to speed, and settles back down. */
const EASE = 12;

export interface Fly {
  readonly active: boolean;
  /** True if the mode changed, so the caller can repaint its own hint. */
  enable(): boolean;
  disable(): boolean;
  /** Advance by dt seconds. Does nothing unless the mode is on. */
  update(dt: number): void;
  /** Called whenever the mode turns itself off, e.g. on losing pointer lock. */
  onExit?: () => void;
  dispose(): void;
}

const KEYS = new Map<string, keyof Held>([
  ['keyw', 'fwd'],
  ['arrowup', 'fwd'],
  ['keys', 'back'],
  ['arrowdown', 'back'],
  ['keya', 'left'],
  ['arrowleft', 'left'],
  ['keyd', 'right'],
  ['arrowright', 'right'],
  ['space', 'up'],
  ['keye', 'up'],
  ['keyq', 'down'],
  ['keyc', 'down'],
  ['shiftleft', 'boost'],
  ['shiftright', 'boost'],
]);

interface Held {
  fwd: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  boost: boolean;
}

/**
 * Fly controls bound to a camera and a canvas.
 *
 * The pointer is locked while flying, which is what lets the mouse turn the
 * camera without ever hitting the edge of the window. Losing that lock - the
 * user pressing escape, or the tab going away - turns the mode off, so the
 * camera can never end up being steered by a mouse the user thinks is free.
 */
export function flyControls(camera: THREE.PerspectiveCamera, dom: HTMLElement): Fly {
  const held: Held = { fwd: false, back: false, left: false, right: false, up: false, down: false, boost: false };
  const velocity = new THREE.Vector3();
  const wish = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const UP = new THREE.Vector3(0, 1, 0);
  let active = false;

  const clearKeys = () => {
    for (const k of Object.keys(held) as (keyof Held)[]) held[k] = false;
  };

  const onMouse = (e: MouseEvent) => {
    if (!active) return;
    euler.y -= e.movementX * LOOK;
    euler.x -= e.movementY * LOOK;
    euler.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, euler.x));
    camera.quaternion.setFromEuler(euler);
  };

  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    if (!active) return;
    const slot = KEYS.get(e.code.toLowerCase());
    if (!slot) return;
    // Space scrolls the page and the arrows move the caret; neither is wanted
    // while the camera is being flown.
    e.preventDefault();
    held[slot] = down;
  };
  const onKeyDown = onKey(true);
  const onKeyUp = onKey(false);

  // The browser drops the lock on escape and on tab switches, and that is the
  // only signal that it happened.
  const onLockChange = () => {
    if (active && document.pointerLockElement !== dom) exit();
  };

  function exit() {
    if (!active) return;
    active = false;
    clearKeys();
    velocity.set(0, 0, 0);
    api.onExit?.();
  }

  document.addEventListener('mousemove', onMouse);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('pointerlockchange', onLockChange);

  const api: Fly = {
    get active() {
      return active;
    },
    enable() {
      if (active) return false;
      active = true;
      // Take the heading from wherever orbit left the camera, so turning fly
      // mode on never jumps the view.
      euler.setFromQuaternion(camera.quaternion, 'YXZ');
      euler.z = 0;
      euler.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, euler.x));
      camera.quaternion.setFromEuler(euler);
      void dom.requestPointerLock?.();
      return true;
    },
    disable() {
      if (!active) return false;
      // Releasing the lock fires the change handler, which does the rest.
      if (document.pointerLockElement === dom) document.exitPointerLock();
      else exit();
      return true;
    },
    update(dt) {
      if (!active) return;
      camera.getWorldDirection(forward);
      right.crossVectors(forward, UP).normalize();
      wish.set(0, 0, 0);
      if (held.fwd) wish.add(forward);
      if (held.back) wish.sub(forward);
      if (held.right) wish.add(right);
      if (held.left) wish.sub(right);
      if (held.up) wish.add(UP);
      if (held.down) wish.sub(UP);
      if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(SPEED * (held.boost ? BOOST : 1));
      // Easing towards the wanted velocity rather than snapping to it is what
      // stops every tap of a key from jolting the view.
      velocity.lerp(wish, Math.min(1, dt * EASE));
      camera.position.addScaledVector(velocity, dt);
    },
    dispose() {
      exit();
      document.removeEventListener('mousemove', onMouse);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('pointerlockchange', onLockChange);
    },
  };
  return api;
}
