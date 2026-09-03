import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CompileResult, Diagnostic } from '../src/types';
import { bakeImage } from './bake';
import { HttpError } from './http';
import { normalizeRel } from './paths';
import type { WorkspaceService } from './service';
import type { SettingsStore } from './settings';
import type { CompileApi } from './router';

const IS_WIN = process.platform === 'win32';

function onPath(name: string): string | null {
  const exts = IS_WIN ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

/** Configured path (env) > settings.typstCli > sidecar next to this executable > PATH. */
export function resolveTypstCli(configured: string | null, fromSettings: string | null): string | null {
  const exists = (p: string | null) => (p && fs.existsSync(p) ? p : null);
  const sidecar = path.join(path.dirname(process.execPath), IS_WIN ? 'typst.exe' : 'typst');
  return exists(configured) ?? exists(fromSettings) ?? exists(sidecar) ?? onPath('typst');
}

const LINE = /^(?:\\\\\?\\)?(.+?):(\d+):(\d+): (error|warning): (.*)$/;

export function parseDiagnostics(stderr: string, root: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const rootAbs = path.resolve(root).replace(/^\\\\\?\\/, '');
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE.exec(line);
    if (m) {
      const abs = m[1]!.replace(/^\\\\\?\\/, '');
      const rel = path.isAbsolute(abs) ? path.relative(rootAbs, abs).split(path.sep).join('/') : abs.replace(/\\/g, '/');
      out.push({ severity: m[4] as Diagnostic['severity'], message: m[5]!, file: rel.startsWith('..') ? abs : rel, line: Number(m[2]), col: Number(m[3]) });
      continue;
    }
    const plain = /^(error|warning): (.*)$/.exec(line);
    if (plain) out.push({ severity: plain[1] as Diagnostic['severity'], message: plain[2]!, file: null, line: null, col: null });
  }
  return out;
}

const TYPST_TIMEOUT_MS = 120_000;

function run(cli: string, args: string[], cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cli, args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: TYPST_TIMEOUT_MS, killSignal: 'SIGKILL' }, (err, _stdout, stderr) => {
      if (err && ((err as { killed?: boolean }).killed || (err as { signal?: string | null }).signal)) {
        resolve({ code: 124, stderr: 'error: typst timed out after 120 s' });
        return;
      }
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stderr: String(stderr ?? '') });
    });
  });
}

export function createCompiler(deps: { settings: SettingsStore; service: WorkspaceService; typstCli: string | null }): CompileApi {
  const cli = () => resolveTypstCli(deps.typstCli, deps.settings.get().typstCli);
  const requireCli = () => { const c = cli(); if (!c) throw new HttpError(409, 'typst CLI not found: set TYPST_CLI or Settings > Typst CLI'); return c; };

  const compileAt = async (root: string, file: string, outPdf: string): Promise<CompileResult> => {
    const fontDir = path.join(root, 'fonts');
    const args = ['compile', '--root', root, '--ignore-system-fonts', '--diagnostic-format', 'short'];
    if (fs.existsSync(fontDir)) args.push('--font-path', fontDir);
    args.push(path.join(root, ...file.split('/')), outPdf);
    const { code, stderr } = await run(requireCli(), args, root);
    const diagnostics = parseDiagnostics(stderr, root);
    return { ok: code === 0 && !diagnostics.some((d) => d.severity === 'error'), diagnostics };
  };

  const entryFile = (file: string | undefined): string => {
    const f = normalizeRel(file ?? 'main.typ');
    if (!f || !f.endsWith('.typ')) throw new HttpError(400, 'file must be a .typ path inside the workspace');
    return f;
  };

  return {
    available: cli,
    async compile(workspaceId, file) {
      const ws = deps.service.fs(workspaceId);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tfs-compile-'));
      try { return await compileAt(ws.root, entryFile(file), path.join(tmp, 'out.pdf')); }
      finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    },
    async exportPdf(workspaceId, file, to) {
      const ws = deps.service.fs(workspaceId);
      const f = entryFile(file);
      const meta = ws.readMeta();
      const framed = Object.entries(meta.assets).filter(([, m]) => (m.crop && !(m.crop.x === 0 && m.crop.y === 0 && m.crop.w === 1 && m.crop.h === 1)) || (m.blurs && m.blurs.length > 0));
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tfs-export-'));
      try {
        let root = ws.root;
        let baked = 0;
        if (framed.length > 0) {
          root = path.join(tmp, 'ws');
          fs.cpSync(ws.root, root, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src) });
          for (const [id, m] of framed) {
            const abs = path.join(root, ...id.split('/'));
            if (!fs.existsSync(abs)) continue;
            let out: Uint8Array | null;
            try {
              out = await bakeImage(new Uint8Array(fs.readFileSync(abs)), m, id);
            } catch (err) {
              throw new HttpError(422, `${id}: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (out) { fs.writeFileSync(abs, out); baked += 1; }
          }
        }
        const outPdf = path.join(tmp, 'out.pdf');
        const res = await compileAt(root, f, outPdf);
        if (!res.ok) {
          const first = res.diagnostics.find((d) => d.severity === 'error');
          throw new HttpError(422, first ? `Typst error at ${first.file ?? '?'}:${first.line ?? '?'}: ${first.message}` : 'document has errors');
        }
        const bytes = new Uint8Array(fs.readFileSync(outPdf));
        if (to) {
          if (!path.isAbsolute(to) || !fs.existsSync(path.dirname(to))) throw new HttpError(400, 'to must be an absolute path in an existing folder');
          fs.writeFileSync(to, bytes);
          return { path: to, bytes: null, baked };
        }
        return { path: null, bytes, baked };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}
