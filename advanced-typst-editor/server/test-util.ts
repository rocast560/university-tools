import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tfs-'));
}
export function rmDir(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}
/** Write a file, creating parents. */
export function put(root: string, rel: string, data: string | Uint8Array): string {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return abs;
}
export const OLD = 'C:/Users/rober/Desktop/typst-editor/recovered-from-docker';
export const TYPST_CLI =
  process.env.TYPST_CLI ??
  'C:/Users/rober/AppData/Local/Microsoft/WinGet/Packages/Typst.Typst_Microsoft.Winget.Source_8wekyb3d8bbwe/typst-x86_64-pc-windows-msvc/typst.exe';
