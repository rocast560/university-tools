import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Every colour in the stylesheet goes through a design token, so a theme
// change is one edit in the :root blocks. This scans client/styles.css for
// colour literals that sit outside a token definition and outside the
// allow-list below, and fails listing them.

const css = readFileSync(new URL('../client/styles.css', import.meta.url), 'utf8');

/** Selectors that may keep literal colours, with the reason. A rule is allowed
 *  when its selector matches one of these. Also always allowed, by structure
 *  rather than by selector: custom-property declarations (`--x: #...`, i.e.
 *  token definition blocks, the --well* bench colours among them) and
 *  anything inside `@media print` (paper is white whatever the theme). */
const ALLOW: [RegExp, string][] = [
  [/#board\b/, 'the breadboard drawn inside #board (holes, rails, parts) is a physical object and keeps its own colours'],
  [/(^|[\s,>+~])\.(wire|jumper)(-[\w-]+)?(?![\w-])/, 'wire swatches show the physical jumper colour'],
  [/(^|[\s,>+~])\.(led|seg|segment)(-[\w-]+)?(?![\w-])/, 'LED and 7-segment swatches show the colour of the part itself'],
  [/(^|[\s,>+~])\.well(-[\w-]+)?(?![\w-])/, 'the well is the constant near-black bench under the board in both themes'],
  [/\.callout/, 'callouts copy the net colour they point at'],
];

type Hit = { line: number; selector: string; decl: string };

function stripComments(s: string): string {
  // keep newlines so line numbers survive
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

function scan(src: string): Hit[] {
  const text = stripComments(src);
  const hits: Hit[] = [];
  const stack: string[] = []; // prelude of each open block
  let buf = '';
  let line = 1;
  let declLine = 1;
  for (const ch of text) {
    if (ch === '\n') line++;
    if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
      continue;
    }
    if (ch === ';' || ch === '}') {
      const decl = buf.trim();
      if (decl) check(decl, declLine);
      buf = '';
      if (ch === '}') stack.pop();
      continue;
    }
    if (!buf.trim()) declLine = line;
    buf += ch;
  }
  return hits;

  function check(decl: string, at: number) {
    if (decl.startsWith('--')) return; // a token definition holds the literal
    const bare = decl.replace(/url\([^)]*\)/g, '');
    if (!LITERAL.test(bare)) return;
    if (stack.some((p) => /^@media\s+print/.test(p))) return; // paper is always white
    const selector = [...stack].reverse().find((p) => !p.startsWith('@')) ?? '';
    if (ALLOW.some(([re]) => re.test(selector))) return;
    hits.push({ line: at, selector: selector.replace(/\s+/g, ' '), decl: decl.replace(/\s+/g, ' ') });
  }
}

test('styles.css: every colour outside wires, LEDs, board, segments, well, print and callouts is a token', () => {
  const hits = scan(css);
  const report = hits.map((h) => `  line ${h.line}: ${h.selector} { ${h.decl} }`).join('\n');
  expect(hits.length === 0 ? '' : `${hits.length} colour literals:\n${report}`).toBe('');
});
