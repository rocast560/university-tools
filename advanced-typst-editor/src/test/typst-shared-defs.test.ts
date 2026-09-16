import { describe, it, expect } from 'vitest';
import { reconcileDefs, splitSharedStyle } from '@/lib/typst-pages';

const SVG_NS = 'http://www.w3.org/2000/svg';
const host = () => document.createElementNS(SVG_NS, 'svg');
const glyphs = (ids: string[]) => `<defs class="glyph">${ids.map((id) => `<path id="${id}" d="M0 0"/>`).join('')}</defs>`;

describe('splitSharedStyle', () => {
  it('lifts every non-empty <style> out of the prelude and leaves the defs', () => {
    const shared = '<style type="text/css">.tsel{position:fixed}</style><defs class="glyph"><path id="a" d="M0 0"/></defs><defs class="clip-path"></defs><style type="text/css"></style>';
    expect(splitSharedStyle(shared)).toEqual({ css: '.tsel{position:fixed}', defs: '<defs class="glyph"><path id="a" d="M0 0"/></defs><defs class="clip-path"></defs>' });
  });
});

describe('reconcileDefs', () => {
  it('adds and removes glyphs by id and keeps the nodes still in use', () => {
    const h = host();
    reconcileDefs(h, glyphs(['a', 'b']) + '<defs class="clip-path"></defs>');
    expect(h.children).toHaveLength(2);
    const a = h.querySelector('#a')!;
    const defs = h.querySelector('defs.glyph')!;
    reconcileDefs(h, glyphs(['a', 'c']));
    expect(h.querySelector('defs.glyph')).toBe(defs); // the block survives
    expect(h.querySelector('#a')).toBe(a); // and so does a glyph still in use
    expect(h.querySelector('#b')).toBeNull();
    expect(h.querySelector('#c')).not.toBeNull();
    expect(h.querySelector('defs.clip-path')).toBeNull(); // block gone from the prelude
    expect(h.querySelector('#c')!.namespaceURI).toBe(SVG_NS);
  });

  it('replaces a glyph whose markup changed under the same id', () => {
    const h = host();
    reconcileDefs(h, glyphs(['a']));
    reconcileDefs(h, '<defs class="glyph"><path id="a" d="M1 1"/></defs>');
    expect(h.querySelector('#a')!.getAttribute('d')).toBe('M1 1');
  });

  it('replaces a block wholesale when its children have no ids', () => {
    const h = host();
    reconcileDefs(h, '<defs class="clip-path"><clipPath><rect/></clipPath></defs>');
    const block = h.querySelector('defs.clip-path')!;
    reconcileDefs(h, '<defs class="clip-path"><clipPath><circle/></clipPath></defs>');
    expect(h.querySelector('defs.clip-path')).toBe(block);
    expect(block.querySelector('circle')).not.toBeNull();
    expect(block.querySelector('rect')).toBeNull();
  });

  it('falls back to innerHTML on markup the XML parser rejects', () => {
    const h = host();
    reconcileDefs(h, '<defs class="glyph"><path id="a" d="M0 0"></defs>');
    expect(h.innerHTML).toContain('id="a"');
  });
});
