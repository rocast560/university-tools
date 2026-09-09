import { describe, expect, test } from 'bun:test';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { makeDesign, parseNetlist } from '../src/netlist.ts';
import { renderSvg, svgSize } from '../src/render/index.ts';
import { RICH } from '../src/render/skin-rich.ts';
import { DARK, LIGHT } from '../src/render/theme.ts';
import { readFixture } from './smoke.test.ts';

const d = parseNetlist(readFixture('PL1_1.net'));
const res = layout(d, emptySidecar());

describe('renderSvg', () => {
  const svg = renderSvg(res);
  test('is one svg element with a viewBox and no undefined values', () => {
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain(`viewBox="${svgSize(res.board).viewBox}"`);
    expect(svg).not.toContain('undefined');
    expect(svg).not.toContain('NaN');
  });
  test('draws every package, part and wire with data attributes', () => {
    for (const p of res.packages) expect(svg).toContain(`data-ref="${p.id}"`);
    for (const p of res.parts) expect(svg).toContain(`data-ref="${p.id}"`);
    expect((svg.match(/class="wire"/g) ?? []).length).toBe(res.wires.length);
    expect(svg).toContain('data-net="/A"');
    expect(svg).toContain(res.nets['/A'].color);
  });
  test('highlight dims everything that is not on the net', () => {
    const h = renderSvg(res, { highlight: { net: '/A' } });
    const dimmed = (h.match(/opacity="0\.18"/g) ?? []).length;
    expect(dimmed).toBeGreaterThan(0);
    expect(dimmed).toBeLessThan(res.wires.length + res.parts.length);
    const w = renderSvg(res, { highlight: { wire: 0 } });
    expect((w.match(/opacity="0\.18"/g) ?? []).length).toBe(res.wires.length - 1 + res.parts.length);
  });
  test('sim state lights LEDs', () => {
    const lit = renderSvg(res, { sim: { leds: { D1: true, D2: false }, segments: {}, switches: {} } });
    expect(lit).toContain('data-led="on"');
    expect(lit).toContain('data-led="off"');
  });
  test('the board is theme independent: dark renders exactly like light', () => {
    // The renderer draws the supply leads and their +5V / GND labels in the
    // margin OUTSIDE the board rect, so a dark board palette puts dark ink on
    // the page itself. The client mounts the SVG in a constant light well
    // (--well in client/styles.css) instead, so the two palettes must stay
    // equal. This fails the moment a divergent DARK field comes back.
    const light = renderSvg(res, { theme: LIGHT });
    expect(renderSvg(res, { theme: DARK })).toBe(light);
    expect(renderSvg(res)).toBe(light);
    expect(light).toContain(LIGHT.board);
    const { name: lightName, ...lightColours } = LIGHT;
    const { name: darkName, ...darkColours } = DARK;
    expect(darkColours).toEqual(lightColours);
    expect(lightName).toBe('light');
    expect(darkName).toBe('dark');
    expect(DARK.dim).toBe(0.18);
  });
  test('all footprints render', () => {
    const d2 = makeDesign({
      Q1: { lib: 'Transistor_BJT', part: '2N3904', value: '2N3904', pins: { '1': ['E', 'passive', 'GND'], '2': ['B', 'input', '/IN'], '3': ['C', 'passive', '/OUT'] } },
      RV1: { lib: 'Device', part: 'R_Potentiometer', value: '10k', pins: { '1': ['1', 'passive', '+5V'], '2': ['2', 'passive', '/IN'], '3': ['3', 'passive', 'GND'] } },
      C1: { lib: 'Device', part: 'C_Polarized', value: '10uF', pins: { '1': ['~', 'passive', '+5V'], '2': ['~', 'passive', 'GND'] } },
      C2: { lib: 'Device', part: 'C', value: '100n', pins: { '1': ['~', 'passive', '/OUT'], '2': ['~', 'passive', 'GND'] } },
      L1: { lib: 'Device', part: 'L', value: '1mH', pins: { '1': ['1', 'passive', '/OUT'], '2': ['2', 'passive', '/X'] } },
      D1: { lib: 'Diode', part: '1N4148', value: '1N4148', pins: { '1': ['K', 'passive', '/X'], '2': ['A', 'passive', 'GND'] } },
      SW1: { lib: 'Switch', part: 'SW_DIP_x02', value: 'SW_DIP_x02', pins: { '1': ['~', 'passive', '/IN'], '2': ['~', 'passive', '/X'], '3': ['~', 'passive', 'GND'], '4': ['~', 'passive', 'GND'] } },
      DS1: { lib: 'Display_Character', part: 'D168K', value: 'D168K', pins: { '7': ['A', 'input', '/OUT'], '6': ['B', 'input', '/X'], '4': ['C', 'input', '/IN'], '2': ['D', 'input', '/d'], '1': ['E', 'input', '/e'], '9': ['F', 'input', '/f'], '10': ['G', 'input', '/g'], '5': ['DP', 'input', 'unconnected-(DS1-Pad5)'], '3': ['CC', 'input', 'GND'], '8': ['CC', 'input', 'GND'] } },
    });
    const r2 = layout(d2, emptySidecar());
    const s2 = renderSvg(r2, { sim: { leds: {}, segments: { DS1: { a: true, b: false, c: true, d: false, e: false, f: false, g: false } }, switches: { SW1: true } } });
    for (const ref of ['Q1', 'RV1', 'C1', 'C2', 'L1', 'D1', 'SW1', 'DS1']) expect(s2).toContain(`data-ref="${ref}"`);
    expect(s2).toContain('data-seg="a" data-lit="on"');
    expect(s2).not.toContain('undefined');
  });
});

describe('the flat skin is a contract', () => {
  // Four things depend on this output byte for byte: resvg in server/png.ts,
  // the MCP render_breadboard picture, the SVG/PNG downloads, and the printed
  // build sheet. None of them can run CSS or JavaScript, and none of them
  // should change when the browser's rich skin does. The golden file is the
  // only thing that catches drift.
  test('renders exactly the checked-in golden SVG', () => {
    expect(renderSvg(res)).toBe(readFixture('PL1_1.flat.svg'));
  });

  test('uses nothing resvg cannot rasterise', () => {
    const svg = renderSvg(res);
    for (const forbidden of ['url(#', 'filter=', '<defs', '<style', 'mix-blend-mode', '<animate', 'class="led"']) {
      expect({ forbidden, present: svg.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  test('is what you get when no skin is asked for', () => {
    expect(renderSvg(res, {})).toBe(renderSvg(res));
  });
});

describe('the rich skin', () => {
  const rich = renderSvg(res, { skin: RICH });

  test('is still one well-formed svg with no holes in it', () => {
    expect(rich.startsWith('<svg')).toBe(true);
    expect(rich.trimEnd().endsWith('</svg>')).toBe(true);
    expect(rich).not.toContain('undefined');
    expect(rich).not.toContain('NaN');
    expect(rich).toContain('<defs>');
  });

  test('draws every part and package, exactly as the flat skin does', () => {
    for (const p of res.packages) expect(rich).toContain(`data-ref="${p.id}"`);
    for (const p of res.parts) expect(rich).toContain(`data-ref="${p.id}"`);
    expect((rich.match(/class="wire"/g) ?? []).length).toBe(res.wires.length);
  });

  test('gives every LED exactly one core, one glow and one spill node', () => {
    // The client finds these once at mount and then patches them every frame.
    // A missing or duplicated hook is a silent null at 60 fps, so it is worth
    // asserting here rather than discovering it in the browser.
    const leds = res.parts.filter((p) => p.style === 'LED');
    expect(leds.length).toBeGreaterThan(0);
    for (const led of leds) {
      for (const attr of ['data-led-core', 'data-led-dome', 'data-led-blow', 'data-glow', 'data-spill']) {
        expect({ attr, ref: led.id, count: (rich.match(new RegExp(`${attr}="${led.id}"`, 'g')) ?? []).length }).toEqual({ attr, ref: led.id, count: 1 });
      }
    }
  });

  test('collapses the holes into bands instead of drawing every one', () => {
    // A half board is about 880 holes. Four pattern-filled rects instead of
    // 880 socket groups is what keeps the static layer affordable.
    expect(rich).not.toContain('data-hole=');
    expect(rich).toContain('url(#bbStripHoles)');
    expect(rich).toContain('url(#bbRailHoles)');
    expect(rich.length).toBeLessThan(renderSvg(res).length * 3);
  });

  test('spends its whole filter budget on two filters, neither board-sized', () => {
    // feTurbulence over the slab would re-run on every zoom notch. It lives
    // in a 64x64 pattern tile; the only other filter is one drop shadow.
    expect((rich.match(/<filter /g) ?? []).length).toBe(2);
    expect(rich).toContain('stitchTiles="stitch"');
  });

  test('is theme independent, like the flat skin', () => {
    expect(renderSvg(res, { skin: RICH, theme: DARK })).toBe(renderSvg(res, { skin: RICH, theme: LIGHT }));
  });

  test('brightens an LED in step with its solved current', () => {
    const dim = renderSvg(res, { skin: RICH, sim: { leds: { D1: true }, segments: {}, switches: {}, ledBrightness: { D1: 0.1 } } });
    const hot = renderSvg(res, { skin: RICH, sim: { leds: { D1: true }, segments: {}, switches: {}, ledBrightness: { D1: 1 } } });
    const core = (svg: string) => Number(/data-led-core="D1"[^/]*opacity="([\d.]+)"/.exec(svg)![1]);
    const glow = (svg: string) => Number(/data-glow="D1"[^/]*opacity="([\d.]+)"/.exec(svg)![1]);
    expect(core(dim)).toBeGreaterThan(0);
    expect(core(dim)).toBeLessThan(core(hot));
    expect(glow(dim)).toBeLessThan(glow(hot));
    expect(core(hot)).toBeCloseTo(1, 6);
  });

  test('an overdriven LED blows out and throws a wider halo', () => {
    const ok = renderSvg(res, { skin: RICH, sim: { leds: { D1: true }, segments: {}, switches: {}, ledBrightness: { D1: 1 } } });
    const over = renderSvg(res, { skin: RICH, sim: { leds: { D1: true }, segments: {}, switches: {}, ledBrightness: { D1: 1 }, ledOverdrive: { D1: 1 } } });
    const blow = (svg: string) => Number(/data-led-blow="D1"[^/]*opacity="([\d.]+)"/.exec(svg)![1]);
    const radius = (svg: string) => Number(/data-glow="D1"[^/]*r="([\d.]+)"/.exec(svg)![1]);
    expect(blow(ok)).toBe(0);
    expect(blow(over)).toBeGreaterThan(0.5);
    expect(radius(over)).toBeGreaterThan(radius(ok));
  });

  test('reads an LED colour from its value', () => {
    const parts = res.parts.map((p) => (p.style === 'LED' ? { ...p, value: 'LED_Blue' } : p));
    const blue = renderSvg({ ...res, parts }, { skin: RICH });
    expect(blue).toContain('#4FA8FF');
    expect(renderSvg(res, { skin: RICH })).toContain('#FF3B30');
  });
});
