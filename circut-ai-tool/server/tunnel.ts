// Public access for clients that can only reach the internet (ChatGPT).
//
// Runs `cloudflared tunnel --url http://127.0.0.1:<port>` as a child process and
// scrapes the https URL it prints. cloudflared is downloaded once into
// DATA_DIR/bin on first use, so nothing has to be installed up front.
//
// This deliberately lives in the server, not the desktop shell, so it works the
// same when the app is run as a plain web app.

import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, PORT } from './config.ts';

const DOWNLOAD_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export type TunnelState = 'off' | 'downloading' | 'starting' | 'on' | 'error';

export interface TunnelStatus {
  state: TunnelState;
  url: string | null;
  message: string | null;
  /** The URL to hand an MCP client, once the tunnel is up. */
  mcpUrl: string | null;
}

export interface Tunnel {
  status(): TunnelStatus;
  start(): Promise<TunnelStatus>;
  stop(): TunnelStatus;
}

const exeName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Download cloudflared to `dir` if it is not already there. Returns its path. */
async function ensureBinary(dir: string): Promise<string> {
  const exe = path.join(dir, exeName);
  if (await exists(exe)) return exe;
  if (process.platform !== 'win32') throw new Error('automatic cloudflared download is only wired up for Windows; install cloudflared and put it on PATH');
  await mkdir(dir, { recursive: true });
  const res = await fetch(DOWNLOAD_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`downloading cloudflared failed (${res.status})`);
  // Write to a temp name first, so an interrupted download cannot leave behind
  // a truncated exe that would then be treated as already installed.
  const tmp = `${exe}.part`;
  try {
    await writeFile(tmp, new Uint8Array(await res.arrayBuffer()));
    await rename(tmp, exe);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return exe;
}

export function createTunnel(opts: { port?: number; dataDir?: string } = {}): Tunnel {
  const port = opts.port ?? PORT;
  const binDir = path.join(opts.dataDir ?? DATA_DIR, 'bin');
  let state: TunnelState = 'off';
  let url: string | null = null;
  let message: string | null = null;
  let child: ChildProcess | null = null;
  let starting: Promise<TunnelStatus> | null = null;

  const status = (): TunnelStatus => ({ state, url, message, mcpUrl: url ? `${url}/mcp` : null });

  function reset(next: TunnelState, msg: string | null) {
    state = next;
    url = null;
    message = msg;
    child = null;
  }

  async function launch(): Promise<TunnelStatus> {
    state = 'downloading';
    message = null;
    let exe: string;
    try {
      exe = await ensureBinary(binDir);
    } catch (e) {
      reset('error', (e as Error).message);
      return status();
    }

    state = 'starting';
    const proc = spawn(exe, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;

    return await new Promise<TunnelStatus>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve(status());
      };
      // cloudflared prints the assigned hostname on stderr; watch both anyway.
      const scan = (chunk: Buffer) => {
        const hit = URL_RE.exec(chunk.toString());
        if (hit && !url) {
          url = hit[0];
          state = 'on';
          done();
        }
      };
      proc.stdout?.on('data', scan);
      proc.stderr?.on('data', scan);
      proc.on('error', (e) => {
        reset('error', e.message);
        done();
      });
      proc.on('exit', (code) => {
        // Only an unexpected exit is an error; stop() clears `child` first.
        if (child === proc) reset('error', `cloudflared exited (${code ?? 'signal'})`);
        done();
      });
      // Don't hang the request forever if cloudflared never prints a URL.
      setTimeout(() => {
        if (!settled) {
          message = 'cloudflared did not report a URL within 30s; still trying in the background';
          done();
        }
      }, 30_000).unref?.();
    });
  }

  const tunnel: Tunnel = {
    status,
    async start() {
      if (state === 'on') return status();
      if (starting) return starting;
      starting = launch().finally(() => (starting = null));
      return starting;
    },
    stop() {
      const proc = child;
      child = null;
      if (proc) proc.kill();
      reset('off', null);
      return status();
    },
  };

  // Never leave a tunnel (and a public URL) alive after the server goes away.
  for (const sig of ['exit', 'SIGINT', 'SIGTERM'] as const) process.on(sig, () => void tunnel.stop());
  return tunnel;
}
