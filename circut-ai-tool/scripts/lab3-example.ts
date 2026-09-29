import { createLibraryLookup } from '../server/libraries.ts';
import { lab3Example } from '../server/lab3-example.ts';
const symbols = process.argv[2] ?? '/usr/share/kicad/symbols';
await Bun.write('examples/Lab3_Prelab_Example.kicad_sch', await lab3Example(createLibraryLookup({ symbolDir: symbols })));
