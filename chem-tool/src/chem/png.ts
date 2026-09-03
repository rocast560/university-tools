// SVG to PNG through resvg-wasm. The wasm module is initialised once per process.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Resvg, initWasm } from '@resvg/resvg-wasm';

let ready: Promise<void> | null = null;

function init(): Promise<void> {
  ready ??= (async () => {
    const wasm = await readFile(fileURLToPath(import.meta.resolve('@resvg/resvg-wasm/index_bg.wasm')));
    await initWasm(wasm);
  })();
  return ready;
}

/** Renders an SVG string to PNG bytes at the given pixel width with a white background. */
export async function svgToPng(svg: string, width = 800): Promise<Uint8Array> {
  await init();
  const concrete = svg.replace(/currentColor/g, '#1a1a1a');
  return new Resvg(concrete, { fitTo: { mode: 'width', value: width }, background: '#ffffff' }).render().asPng();
}
