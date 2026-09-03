import { expect, test } from 'vitest';
import { svgToPng } from './png';
import { parseSmiles, toSvg } from './structure';

test('svgToPng produces a PNG of the requested width', async () => {
  const png = await svgToPng(toSvg(parseSmiles('CCO')!), 300);
  expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  // IHDR width is bytes 16..19 big-endian
  const width = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
  expect(width).toBe(300);
});
