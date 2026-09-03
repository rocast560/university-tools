import path from 'node:path';
import { importLegacy } from './legacy-import';

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'import-legacy') {
  const legacyDir = rest[0];
  const flag = rest.indexOf('--data-dir');
  const dataDir = path.resolve(flag >= 0 ? rest[flag + 1]! : process.env.DATA_DIR ?? './data');
  if (!legacyDir) { console.error('usage: bun server/cli.ts import-legacy <legacyDir> [--data-dir <dir>]'); process.exit(2); }
  const r = importLegacy({ legacyDir: path.resolve(legacyDir), dataDir });
  console.log(`imported ${r.imported.length} workspace(s) into ${dataDir}`);
} else {
  console.error('commands: import-legacy');
  process.exit(2);
}
