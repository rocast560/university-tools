import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveStdioBridge } from './mcp';
import { tmpDir, rmDir } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

describe('resolveStdioBridge', () => {
  it('returns the absolute path of mcp-stdio.ts next to the running server', () => {
    const d = tmpDir(); dirs.push(d);
    fs.writeFileSync(path.join(d, 'mcp-stdio.ts'), '// bridge');
    expect(resolveStdioBridge(d, { inContainer: false })).toBe(path.join(d, 'mcp-stdio.ts'));
  });

  it('returns null when the bridge script is not on disk (compiled sidecar)', () => {
    const d = tmpDir(); dirs.push(d);
    expect(resolveStdioBridge(d, { inContainer: false })).toBeNull();
  });

  it('returns null inside a container: the path would be meaningless on the host', () => {
    const d = tmpDir(); dirs.push(d);
    fs.writeFileSync(path.join(d, 'mcp-stdio.ts'), '// bridge');
    expect(resolveStdioBridge(d, { inContainer: true })).toBeNull();
  });
});
