// bun scripts/breadboard.ts <file.kicad_sch> [--net file.net] [--out dir]
// Exports the netlist with kicad-cli (unless --net is given), builds the
// layout and writes <stem>.breadboard.json and <stem>.breadboard.svg.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeSidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc, summarize } from '../src/pipeline.ts';
import { renderSvg } from '../src/render/index.ts';

const args = process.argv.slice(2);
const sch = args.find((a) => !a.startsWith('--'));
if (!sch) {
  console.error('usage: bun scripts/breadboard.ts <file.kicad_sch> [--net file.net] [--out dir]');
  process.exit(2);
}
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const schPath = path.resolve(sch);
const stem = path.basename(schPath, '.kicad_sch');
const outDir = opt('--out') ? path.resolve(opt('--out')!) : path.dirname(schPath);
mkdirSync(outDir, { recursive: true });

let netText: string;
const netArg = opt('--net');
if (netArg) netText = readFileSync(netArg, 'utf8');
else {
  const cli = process.env.KICAD_CLI ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'KiCad', '9.0', 'bin', 'kicad-cli.exe');
  const tmp = path.join(tmpdir(), `${stem}-${Date.now()}.net`);
  execFileSync(cli, ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', tmp, schPath], { stdio: 'pipe' });
  netText = readFileSync(tmp, 'utf8');
}
const sidecarPath = path.join(path.dirname(schPath), `${stem}.breadboard.json`);
const sidecar = existsSync(sidecarPath) ? normalizeSidecar(JSON.parse(readFileSync(sidecarPath, 'utf8'))) : normalizeSidecar({});
const doc = buildLayoutDoc(parseNetlist(netText), sidecar);
writeFileSync(path.join(outDir, `${stem}.breadboard.layout.json`), JSON.stringify(doc, null, 1));
writeFileSync(path.join(outDir, `${stem}.breadboard.svg`), renderSvg(doc));
console.log(summarize(doc));
console.log(`wrote ${path.join(outDir, `${stem}.breadboard.svg`)}`);
