// Component value parsing ("4k7", "10uF", "2.2mH") and reference ordering.

const MULT: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

export function parseOhms(value: string): number | null {
  const s = (value ?? '').trim().replace(/Ω|ohms?/gi, '').replace(/\s+/g, '');
  let m = /^(\d+)([kKMRr])(\d*)$/.exec(s);
  if (m) {
    const mult = m[2] === 'R' || m[2] === 'r' ? 1 : m[2] === 'M' ? 1e6 : 1e3;
    return (Number(m[1]) + (m[3] ? Number('0.' + m[3]) : 0)) * mult;
  }
  m = /^(\d+(?:\.\d+)?)([kKMm]?)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * (m[2] === '' ? 1 : m[2] === 'm' ? 1e-3 : m[2] === 'M' ? 1e6 : 1e3);
}

function parseWithUnit(value: string, unit: RegExp): number | null {
  const s = (value ?? '').trim().replace(unit, '').replace(/\s+/g, '');
  let m = /^(\d+)([pnuµμm])(\d+)$/.exec(s);
  if (m) return (Number(m[1]) + Number('0.' + m[3])) * MULT[m[2]];
  m = /^(\d+(?:\.\d+)?)([pnuµμmkKM]?)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * MULT[m[2]];
}

export const parseFarads = (value: string): number | null => parseWithUnit(value, /F(arads?)?$/i);
export const parseHenries = (value: string): number | null => parseWithUnit(value, /H(enr(y|ies))?$/i);

const SI: [number, string][] = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];

export function formatSI(x: number, unit: string): string {
  for (const [f, p] of SI) if (Math.abs(x) >= f * 0.9995) return `${Number((x / f).toPrecision(3))} ${p}${unit}`.trim();
  return `${x} ${unit}`.trim();
}

export function refKey(ref: string): [string, number] {
  const m = /^([A-Za-z#]+)(\d*)/.exec(ref);
  return m ? [m[1], Number(m[2] || 0)] : [ref, 0];
}

export function compareRefs(a: string, b: string): number {
  const [pa, na] = refKey(a);
  const [pb, nb] = refKey(b);
  return pa < pb ? -1 : pa > pb ? 1 : na - nb;
}
