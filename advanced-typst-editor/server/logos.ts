import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LOGO_TYPES, MAX_LOGO_BYTES, isLogoName, logoTypeError } from '../src/lib/logo';
import { writeAtomic } from './fsx';
import { HttpError } from './http';

/**
 * Uploaded sidebar logos, kept in `<dataDir>/logos/`. They are small and are
 * never deleted: clearing a logo only unlinks it from the registry, so a mistaken
 * click can always be undone by picking the file again from the folder.
 */
export interface LogoStore {
  /** Validates and writes the image; returns its generated file name. Throws an HttpError (415 type, 413 size, 400 empty). */
  save(bytes: Uint8Array, contentType: string): string;
  /** The file's bytes, or null for an unsafe or unknown name. */
  read(name: string): Buffer | null;
}

export function createLogoStore(dataDir: string): LogoStore {
  const dir = path.join(dataDir, 'logos');
  return {
    save(bytes, contentType) {
      const type = contentType.split(';')[0]!.trim().toLowerCase();
      const problem = logoTypeError(type, bytes.length);
      if (problem) throw new HttpError(!(type in LOGO_TYPES) ? 415 : bytes.length > MAX_LOGO_BYTES ? 413 : 400, problem);
      const name = `${crypto.randomBytes(8).toString('hex')}.${LOGO_TYPES[type]}`;
      writeAtomic(path.join(dir, name), bytes);
      return name;
    },
    read(name) {
      if (!isLogoName(name)) return null;
      try { return fs.readFileSync(path.join(dir, name)); } catch { return null; }
    },
  };
}
