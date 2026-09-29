// The arithmetic behind "fly the camera to this part", kept free of three so
// it can be tested: where to look, and how far back to stand so the part
// fills the view with some air round it.

/** OrbitControls.minDistance in board3d.ts; a focus never lands inside it. */
const MIN_DISTANCE = 60;

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export function frameBox(box: { min: number[]; max: number[] }, fovDeg: number, aspect: number, padding: number): { target: [number, number, number]; distance: number } {
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const target: [number, number, number] = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const radius = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2;
  // The narrower of the two fields of view decides, so the part fits both ways.
  const vfov = (fovDeg * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const distance = (radius * padding) / Math.sin(Math.min(vfov, hfov) / 2);
  return { target, distance: Math.max(MIN_DISTANCE, distance) };
}
