import { describe, it, expect } from 'vitest';
import { DEFAULT_TEMPLATE, DEFAULT_WORKSPACE_NAME } from '@/template';

describe('starter template', () => {
  it('defines the figure helper and two slots', () => {
    expect(DEFAULT_WORKSPACE_NAME).toBe('Untitled report');
    expect(DEFAULT_TEMPLATE).toContain('#let image-placeholder(caption, path: none, height: 2.2in)');
    expect(DEFAULT_TEMPLATE.match(/#image-placeholder\(/g)?.length).toBe(2);
    expect(DEFAULT_TEMPLATE).toContain('Typst Studio');
  });
});
