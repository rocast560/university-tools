// Generates the rendered text runs for the source-map fixtures.
//
//   node scripts/gen-source-map-fixtures.mjs        (Git Bash tool; Node 20+)
//
// For every `src/test/fixtures/source-map/<name>.typ` it compiles the document
// with the project's own typst.ts 0.7 wasm packages (the same compiler and
// embedded fonts the preview uses), renders it to SVG, and writes
// `<name>.runs.json` next to it: `{ pages: string[][] }`, one array of `.tsel`
// run texts per page, in document order. That is exactly what
// `splitTypstPages` + `extractTextRuns` give the preview at click time, so the
// corpus test (src/test/typst-source-map-corpus.test.ts) can replay clicks
// without wasm.
//
// Run it again whenever a fixture `.typ` changes, then re-check the `.clicks.json`
// labels (the test asserts each label's run text still matches).
//
// Page extraction mirrors lib/typst-pages: top-level `g.typst-page` groups, and
// `foreignObject` textContent parsed with the HTML parser (jsdom here).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'src/test/fixtures/source-map');
const nm = path.join(root, 'node_modules/@myriaddreamin');
const { JSDOM } = createRequire(path.join(root, 'package.json'))('jsdom');

const ts = await import(pathToFileURL(path.join(nm, 'typst.ts/dist/esm/index.mjs')).href);
const { createTypstCompiler, createTypstRenderer, loadFonts } = ts;

const fontDir = path.join(root, 'public/fonts');
const fonts = fs.readdirSync(fontDir).map((f) => new Uint8Array(fs.readFileSync(path.join(fontDir, f))));
const cwasm = fs.readFileSync(path.join(nm, 'typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm'));
const rwasm = fs.readFileSync(path.join(nm, 'typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm'));

const compiler = createTypstCompiler();
await compiler.init({ getModule: () => cwasm, beforeBuild: [loadFonts(fonts, { assets: false })] });
const renderer = createTypstRenderer();
await renderer.init({ getModule: () => rwasm });

const runsOfPage = (pageEl) => Array.from(pageEl.querySelectorAll('foreignObject')).map((o) => o.textContent ?? '');

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.typ')).sort()) {
  const name = file.replace(/\.typ$/, '');
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  compiler.addSource('/main.typ', src);
  await compiler.reset();
  const res = await compiler.compile({ mainFilePath: '/main.typ', format: 0, diagnostics: 'full' });
  if (!res.result) {
    console.error(`${name}: compile failed`, JSON.stringify(res.diagnostics ?? res, null, 1));
    process.exitCode = 1;
    continue;
  }
  const svg = await renderer.runWithSession(async (s) => {
    renderer.manipulateData({ renderSession: s, action: 'reset', data: res.result });
    return renderer.renderSvg({ renderSession: s });
  });
  const dom = new JSDOM(`<!doctype html><body>${svg}</body>`);
  const pages = Array.from(dom.window.document.querySelectorAll('g.typst-page')).map(runsOfPage);
  fs.writeFileSync(path.join(dir, `${name}.runs.json`), JSON.stringify({ pages }, null, 1) + '\n');
  const total = pages.reduce((n, p) => n + p.length, 0);
  console.log(`${name}: ${pages.length} pages, ${total} runs`);
}
process.exit(process.exitCode ?? 0);
