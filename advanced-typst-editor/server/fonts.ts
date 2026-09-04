import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Family name from an SFNT (ttf/otf/ttc) `name` table. Prefers the
 * typographic family (nameID 16) over the legacy family (nameID 1), and
 * Windows Unicode (platform 3) over Macintosh (platform 1). This is what
 * Typst matches in `#set text(font: "...")`.
 */
export function fontFamily(bytes: Uint8Array): string | null {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o: number) => dv.getUint16(o);
    const u32 = (o: number) => dv.getUint32(o);
    const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
    let base = 0;
    if (tag(0) === 'ttcf') base = u32(12); // first face of a collection
    const magic = u32(base);
    if (magic !== 0x00010000 && tag(base) !== 'OTTO' && tag(base) !== 'true') return null;
    const numTables = u16(base + 4);
    let nameOff = -1;
    let nameLen = 0;
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      if (tag(rec) === 'name') { nameOff = u32(rec + 8); nameLen = u32(rec + 12); break; }
    }
    if (nameOff < 0 || nameOff + nameLen > bytes.length) return null;
    const count = u16(nameOff + 2);
    const stringsOff = nameOff + u16(nameOff + 4);
    const candidates: Array<{ score: number; value: string }> = [];
    for (let i = 0; i < count; i++) {
      const rec = nameOff + 6 + i * 12;
      const platform = u16(rec), encoding = u16(rec + 2), language = u16(rec + 4), nameId = u16(rec + 6), length = u16(rec + 8), offset = u16(rec + 10);
      if (nameId !== 1 && nameId !== 16) continue;
      const start = stringsOff + offset;
      if (start + length > bytes.length) continue;
      const raw = bytes.subarray(start, start + length);
      let value: string;
      if (platform === 3 || (platform === 0)) {
        value = Buffer.from(raw).swap16().toString('utf16le'); // UTF-16BE
      } else if (platform === 1) {
        value = Buffer.from(raw).toString('latin1');
      } else continue;
      value = value.replace(/\0/g, '').trim();
      if (!value) continue;
      // Prefer: nameID 16, then platform 3 English (0x0409), then anything.
      const score = (nameId === 16 ? 100 : 0) + (platform === 3 ? 10 : platform === 0 ? 5 : 0) + (language === 0x0409 || language === 0 ? 1 : 0) + (encoding === 1 ? 0 : 0);
      candidates.push({ score, value });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Parse typst fonts --variants output to find which family was added.
 * Lines not starting with whitespace are family headers; lines matching /^\s*- Style:/ are faces.
 */
export function familyOfAddedFace(base: string, withFont: string): string | null {
  const parseListing = (listing: string): Map<string, number> => {
    const families = new Map<string, number>();
    let currentFamily: string | null = null;
    for (const line of listing.split('\n')) {
      if (/^\s*- Style:/.test(line)) {
        // It's a face line under the current family
        if (currentFamily) families.set(currentFamily, (families.get(currentFamily) ?? 0) + 1);
      } else if (line.trim() && !line.startsWith(' ')) {
        // It's a family header
        currentFamily = line.trim();
        families.set(currentFamily, 0);
      }
    }
    return families;
  };

  const baseFamilies = parseListing(base);
  const withFamilies = parseListing(withFont);

  for (const [family, count] of withFamilies) {
    if ((baseFamilies.get(family) ?? 0) < count) {
      return family;
    }
  }
  return null;
}

/** Cache of base font listings per CLI path to avoid repeated spawning */
const baseListingCache = new Map<string, Promise<string>>();

/**
 * Family name via typst CLI fonts --variants output. Falls back to null if CLI unavailable.
 * Caches the base listing per CLI path to minimize process spawning.
 */
export async function fontFamilyViaTypst(cli: string | null, bytes: Uint8Array, ext: string): Promise<string | null> {
  if (!cli) return null;

  // Normalize extension to start with '.'
  const extNorm = ext.startsWith('.') ? ext : `.${ext}`;

  // Get or fetch base listing (cached)
  let baseListing: string;
  if (!baseListingCache.has(cli)) {
    const basePromise = execFileAsync(cli, ['fonts', '--ignore-system-fonts', '--variants'], {
      windowsHide: true,
      timeout: 10000,
    }).then((res) => res.stdout).catch(() => '');
    baseListingCache.set(cli, basePromise);
  }
  baseListing = await baseListingCache.get(cli)!;

  // Create temp dir, write font, run with font, clean up
  let tempDir: string | null = null;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfs-font-'));
    const fontPath = path.join(tempDir, `font${extNorm}`);
    fs.writeFileSync(fontPath, bytes);

    const { stdout: withFontOutput } = await execFileAsync(cli, ['fonts', '--ignore-system-fonts', '--variants', '--font-path', tempDir], {
      windowsHide: true,
      timeout: 10000,
    });

    return familyOfAddedFace(baseListing, withFontOutput);
  } catch {
    return null;
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
    }
  }
}
