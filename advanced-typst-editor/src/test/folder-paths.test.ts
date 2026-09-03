import { describe, it, expect } from 'vitest';
import { folderPathFor, movedFolderPath, renamedFolderPath } from '@/lib/folder-paths';

describe('folder paths', () => {
  it('maps panel intentions to assets/-relative paths', () => {
    expect(folderPathFor(null, ' Findings ')).toBe('Findings');
    expect(folderPathFor('Findings', 'a/b')).toBe('Findings/a_b');
    expect(renamedFolderPath('Findings/auth', 'Auth Bypass')).toBe('Findings/Auth Bypass');
    expect(renamedFolderPath('top', 'x')).toBe('x');
    expect(movedFolderPath('Findings/auth', null)).toBe('auth');
    expect(movedFolderPath('auth', 'Appendix')).toBe('Appendix/auth');
  });
});
