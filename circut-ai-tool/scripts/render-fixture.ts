// Dev helper: re-render the checked-in golden SVG from the checked-in netlist.
// Run with `bun scripts/render-fixture.ts` after any change to the flat skin.
import { layout } from '../src/layout/engine.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { renderSvg } from '../src/render/index.ts';

const net = await Bun.file(new URL('../test/fixtures/PL1_1.net', import.meta.url)).text();
const svg = renderSvg(layout(parseNetlist(net), emptySidecar()));
await Bun.write(new URL('../test/fixtures/PL1_1.flat.svg', import.meta.url), svg);
console.log(`wrote test/fixtures/PL1_1.flat.svg (${svg.length} bytes)`);
