// Builds the server sidecar and stages every artefact the launcher bundles.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const app = path.resolve(import.meta.dirname, '..');
const launcher = path.resolve(app, '..', 'launcher', 'src-tauri');
const binaries = path.join(launcher, 'binaries');
const resources = path.join(launcher, 'resources', 'typst', 'dist');
const TYPST_SRC = process.env.TYPST_CLI ?? 'C:/Users/rober/AppData/Local/Microsoft/WinGet/Packages/Typst.Typst_Microsoft.Winget.Source_8wekyb3d8bbwe/typst-x86_64-pc-windows-msvc/typst.exe';

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { cwd: app, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error(`${cmd} ${args.join(' ')} failed (${r.status})`); process.exit(r.status ?? 1); }
}

fs.mkdirSync(binaries, { recursive: true });
const out = path.join(binaries, 'tfs-server-x86_64-pc-windows-msvc.exe');
const base = ['build', '--compile', '--minify', '--target=bun-windows-x64', 'server/index.ts', '--outfile', out];
const withBytecode = spawnSync('bun', [...base.slice(0, 3), '--bytecode', ...base.slice(3)], { cwd: app, stdio: 'inherit', shell: true });
if (withBytecode.status !== 0) { console.warn('--bytecode rejected; building without it'); run('bun', base); }

if (!fs.existsSync(path.join(app, 'dist', 'index.html'))) { console.error('dist/ missing: run `bun run build` first'); process.exit(1); }
fs.rmSync(resources, { recursive: true, force: true });
fs.cpSync(path.join(app, 'dist'), resources, { recursive: true });

if (!fs.existsSync(TYPST_SRC)) { console.error(`typst.exe not found at ${TYPST_SRC}; set TYPST_CLI`); process.exit(1); }
fs.copyFileSync(TYPST_SRC, path.join(binaries, 'typst-x86_64-pc-windows-msvc.exe'));
console.log(`sidecar: ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
console.log(`ui:      ${resources}`);
console.log(`typst:   ${path.join(binaries, 'typst-x86_64-pc-windows-msvc.exe')}`);
