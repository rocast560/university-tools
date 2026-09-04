// Builds the server sidecar and stages every artefact the shell bundles.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const app = path.resolve(import.meta.dirname, '..');
const tauri = path.join(app, 'src-tauri');
const binaries = path.join(tauri, 'binaries');
const resources = path.join(tauri, 'resources', 'dist');

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { cwd: app, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(' ')} failed (${r.status})`);
    process.exit(r.status ?? 1);
  }
}

if (!fs.existsSync(path.join(app, 'dist', 'index.html'))) {
  console.error('dist/ missing: run `bun run build` first');
  process.exit(1);
}

fs.mkdirSync(binaries, { recursive: true });
const out = path.join(binaries, 'circuit-server-x86_64-pc-windows-msvc.exe');
// --bytecode is rejected here: server/index.ts has a top-level await, and Bun
// errors with `"await" can only be used inside an "async" function`. Omitted.
run('bun', ['build', '--compile', '--minify', '--target=bun-windows-x64', 'server/index.ts', '--outfile', out]);

fs.rmSync(resources, { recursive: true, force: true });
fs.cpSync(path.join(app, 'dist'), resources, { recursive: true });

console.log(`sidecar: ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
console.log(`ui:      ${resources}`);
