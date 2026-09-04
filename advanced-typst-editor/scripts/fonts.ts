// Puts the 17 fonts typst.ts installs by default under public/fonts, so the
// compiler never touches the CDN (the app must work offline).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FONT_FILES = [
  'DejaVuSansMono-Bold.ttf', 'DejaVuSansMono-BoldOblique.ttf', 'DejaVuSansMono-Oblique.ttf', 'DejaVuSansMono.ttf',
  'LibertinusSerif-Bold.otf', 'LibertinusSerif-BoldItalic.otf', 'LibertinusSerif-Italic.otf', 'LibertinusSerif-Regular.otf',
  'LibertinusSerif-Semibold.otf', 'LibertinusSerif-SemiboldItalic.otf',
  'NewCM10-Bold.otf', 'NewCM10-BoldItalic.otf', 'NewCM10-Italic.otf', 'NewCM10-Regular.otf',
  'NewCMMath-Bold.otf', 'NewCMMath-Book.otf', 'NewCMMath-Regular.otf',
];
const LOCAL = 'C:/Users/rober/Desktop/typst-editor/recovered-from-docker/fonts';
const CDN = 'https://cdn.jsdelivr.net/gh/typst/typst-assets@v0.13.1/files/fonts/';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const out = path.resolve(__dirname, '..', 'public', 'fonts');
  fs.mkdirSync(out, { recursive: true });
  for (const name of FONT_FILES) {
    const target = path.join(out, name);
    if (fs.existsSync(target)) continue;
    const local = path.join(LOCAL, name);
    if (fs.existsSync(local)) { fs.copyFileSync(local, target); continue; }
    const res = await fetch(CDN + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    fs.writeFileSync(target, new Uint8Array(await res.arrayBuffer()));
  }
  console.log(`fonts: ${FONT_FILES.length} files in ${out}`);
}
if (process.argv[1] && /fonts\.ts$/.test(process.argv[1])) void main();
