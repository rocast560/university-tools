import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Folder, Shield } from 'lucide-react';
import { FOLDER_COLORS, FOLDER_ICON_NAMES, folderColorVar, folderIcon } from '@/components/sidebar/folder-icons';

describe('folder colors', () => {
  it('offers ten names and maps them to theme variables', () => {
    expect(FOLDER_COLORS).toHaveLength(10);
    expect(new Set(FOLDER_COLORS).size).toBe(10);
    expect(folderColorVar('blue')).toBe('hsl(var(--folder-blue))');
  });

  it('treats no color and an unknown color as the default', () => {
    expect(folderColorVar(null)).toBeNull();
    expect(folderColorVar(undefined)).toBeNull();
    expect(folderColorVar('chartreuse')).toBeNull();
  });

  it('defines every color in both themes', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
    const light = css.slice(css.indexOf(':root {'), css.indexOf('.dark {'));
    const dark = css.slice(css.indexOf('.dark {'));
    for (const c of FOLDER_COLORS) {
      expect(light, `--folder-${c} missing from :root`).toContain(`--folder-${c}:`);
      expect(dark, `--folder-${c} missing from .dark`).toContain(`--folder-${c}:`);
    }
  });
});

describe('folder icons', () => {
  it('offers forty distinct icons and resolves them', () => {
    expect(FOLDER_ICON_NAMES).toHaveLength(40);
    expect(new Set(FOLDER_ICON_NAMES).size).toBe(40);
    expect(folderIcon('shield')).toBe(Shield);
  });

  it('falls back to a plain folder rather than throwing', () => {
    expect(folderIcon(null)).toBe(Folder);
    expect(folderIcon(undefined)).toBe(Folder);
    expect(folderIcon('not-an-icon')).toBe(Folder);
  });

  it('resolves every advertised name', () => {
    for (const n of FOLDER_ICON_NAMES) expect(folderIcon(n), n).toBeTruthy();
  });
});
