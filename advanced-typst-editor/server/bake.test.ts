import { describe, it, expect } from 'vitest';
import { Jimp } from 'jimp';
import { bakeImage } from './bake';

/** 200x100 white PNG with a 1px black/white stripe pattern in the middle 100x40 region. */
async function stripes(): Promise<Uint8Array> {
  const img = new Jimp({ width: 200, height: 100, color: 0xffffffff });
  for (let y = 30; y < 70; y++) for (let x = 50; x < 150; x++) if (x % 2 === 0) img.setPixelColor(0x000000ff, x, y);
  return new Uint8Array(await img.getBuffer('image/png'));
}
async function stats(png: Uint8Array, x0: number, y0: number, w: number, h: number) {
  const img = await Jimp.read(Buffer.from(png));
  let min = 255, max = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const v = (img.getPixelColor(x, y) >>> 24) & 0xff; // red channel
    min = Math.min(min, v); max = Math.max(max, v);
  }
  return { min, max, width: img.bitmap.width, height: img.bitmap.height };
}

describe('bakeImage', () => {
  it('returns null when there is nothing to bake', async () => {
    expect(await bakeImage(await stripes(), {}, 'a.png')).toBeNull();
    expect(await bakeImage(await stripes(), { crop: { x: 0, y: 0, w: 1, h: 1 } }, 'a.png')).toBeNull();
  });
  it('destroys detail inside a gaussian region and leaves the outside alone', async () => {
    const out = await bakeImage(await stripes(), { blurs: [{ x: 0.25, y: 0.3, w: 0.5, h: 0.4 }] }, 'a.png');
    const inside = await stats(out!, 60, 35, 80, 30);
    expect(inside.max - inside.min).toBeLessThan(60); // stripes averaged to grey
    const outside = await stats(out!, 0, 0, 40, 20);
    expect(outside.min).toBe(255);
  });
  it('pixelates into flat blocks', async () => {
    const out = await bakeImage(await stripes(), { blurs: [{ x: 0.25, y: 0.3, w: 0.5, h: 0.4, style: 'pixelate' }] }, 'a.png');
    const inside = await stats(out!, 60, 35, 6, 6);
    expect(inside.max - inside.min).toBeLessThan(8); // one block is one colour
  });
  it('crops to the output size with the placeholder grey where the image runs out', async () => {
    const out = await bakeImage(await stripes(), { crop: { x: 0.5, y: 0, w: 1, h: 0.5 } }, 'a.png');
    const s = await stats(out!, 150, 0, 40, 40); // right half of the crop is past the image edge
    expect(s.width).toBe(200); expect(s.height).toBe(50);
    expect(s.min).toBe(0xf5); expect(s.max).toBe(0xf5);
  });
  it('refuses formats jimp cannot re-encode', async () => {
    await expect(bakeImage(new Uint8Array([0]), { crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }, 'a.svg')).rejects.toThrow(/cannot be baked/);
  });
});
