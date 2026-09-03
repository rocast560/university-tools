// SVG -> PNG through resvg. Loaded lazily so a broken native addon only
// disables PNG output instead of the whole server.

export class PngError extends Error {}

type ResvgCtor = new (svg: string, opts: unknown) => { render(): { asPng(): Uint8Array } };
let ctor: ResvgCtor | null | undefined;

function load(): ResvgCtor | null {
  if (ctor !== undefined) return ctor;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ctor = (require('@resvg/resvg-js') as { Resvg: ResvgCtor }).Resvg;
  } catch {
    ctor = null;
  }
  return ctor;
}

export function pngAvailable(): boolean {
  return load() !== null;
}

export function renderPng(svg: string, width = 1600): Uint8Array {
  const Resvg = load();
  if (!Resvg) throw new PngError('PNG rendering is unavailable: @resvg/resvg-js failed to load. SVG output still works.');
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: '#F6F4EE', font: { loadSystemFonts: true, defaultFontFamily: 'Consolas' } });
  return r.render().asPng();
}
