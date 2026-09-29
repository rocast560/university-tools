import { parseSchematic, pinsOfUnit } from '../src/kicad/schematic.ts';
import { appendTopLevel, insertLibSymbol, labelNode, symbolNode } from '../src/kicad/writer.ts';
import { pinEnd } from '../src/kicad/ops.ts';
import { L3_ID } from '../src/parts/lab3.ts';
import type { LibraryLookup } from './libraries.ts';

/** A complete prelab example: auxiliary a-d plus discrete gates for e-g. */
export async function lab3Example(libs: LibraryLookup): Promise<string> {
  const project = 'Lab3_Prelab_Example';
  let sch = parseSchematic(`(kicad_sch (version 20250114) (generator "eeschema") (uuid "${crypto.randomUUID()}") (paper "A3") (lib_symbols))`, project);
  const add = async (libId: string, ref: string, value: string, connections: Record<string, string>, spots: [number, number][]) => {
    sch = parseSchematic(insertLibSymbol(sch, await libs.symbolText(libId)), project);
    const lib = sch.libSymbols.get(libId)!;
    for (let unit = 1; unit <= lib.unitCount; unit++) {
      const [x, y] = spots[unit - 1] ?? spots[0];
      let node = symbolNode({ libId, ref, value, at: { x, y }, unit, pinNumbers: pinsOfUnit(lib, unit).map(p => p.number), project, rootUuid: sch.uuid });
      const tall = libId === L3_ID ? 27.94 : libId.startsWith('Display') ? 22.86 : libId.startsWith('Switch') ? 17.78 : 10.16;
      node = node.replace(/(property "Reference" "[^"]*"\s*\(at )[^)]*/, `$1${x + 2.54} ${y - tall} 0`);
      node = node.replace(/(property "Value" "[^"]*"\s*\(at )[^)]*/, `$1${x + 2.54} ${y - tall + 2.54} 0`);
      if (libId.startsWith('Device:')) {
        node = node.replace(/(property "Reference" "[^"]*"\s*\(at )[^)]*/, `$1${x + 5.08} ${y - 1.27} 0`);
        node = node.replace(/(property "Value" "[^"]*"\s*\(at )[^)]*/, `$1${x + 5.08} ${y + 1.27} 0`);
      }
      sch = parseSchematic(appendTopLevel(sch, node), project);
    }
    for (const [pin, net] of Object.entries(connections)) {
      const end = pinEnd(sch, ref, pin);
      if (!end) throw new Error(`${ref} missing pin ${pin}`);
      const at = { x: end.at.x + end.away.x * 2.54, y: end.at.y + end.away.y * 2.54 };
      sch = parseSchematic(appendTopLevel(sch, `(wire (pts (xy ${end.at.x} ${end.at.y}) (xy ${at.x} ${at.y})) (stroke (width 0) (type default)) (uuid "${crypto.randomUUID()}"))`), project);
      sch = parseSchematic(appendTopLevel(sch, labelNode({ kind: 'global_label', text: net, at, rot: end.away.x < 0 ? 180 : 0 })), project);
    }
  };
  await add(L3_ID, 'U1', 'L3_Auxiliary', { 1: '+5V', 2: 'GND', 3: 'W', 4: 'X', 5: 'Y', 6: 'Z', 8: 'Wn', 9: 'Xn', 10: 'Yn', 11: 'Zn', 12: 'a', 13: 'b', 14: 'c', 15: 'd' }, [[55.88, 63.5]]);
  await add('Switch:SW_DIP_x04', 'SW1', 'SW_DIP_x04', { 1: 'W', 2: 'X', 3: 'Y', 4: 'Z', 8: 'GND', 7: 'GND', 6: 'GND', 5: 'GND' }, [[139.7, 63.5]]);
  for (let i = 0; i < 4; i++) await add('Device:R', `R${8 + i}`, '4.7k', { 1: '+5V', 2: 'WXYZ'[i] }, [[190.5 + i * 30.48, 63.5]]);
  await add('Display_Character:SA39-11EWA', 'DS1', 'SA39-11EWA', { 10: 'LED_a', 9: 'LED_b', 7: 'LED_c', 5: 'LED_d', 4: 'LED_e', 2: 'LED_f', 1: 'LED_g', 3: '+5V', 8: '+5V' }, [[355.6, 63.5]]);
  // e = Z + X Yn; f = Wn Xn Z + Xn Y + Y Z; g = Wn Xn Yn + X Y Z.
  await add('74xx:74LS08', 'U2', '74LS08', { 1: 'X', 2: 'Yn', 3: 'e1', 4: 'Wn', 5: 'Xn', 6: 't', 9: 't', 10: 'Z', 8: 'f1', 12: 'Xn', 13: 'Y', 11: 'f2', 14: '+5V', 7: 'GND' }, [[38.1, 129.54], [114.3, 129.54], [190.5, 129.54], [266.7, 129.54], [355.6, 129.54]]);
  await add('74xx:74LS08', 'U3', '74LS08', { 1: 'Y', 2: 'Z', 3: 'yz', 4: 't', 5: 'Yn', 6: 'g0', 9: 'X', 10: 'yz', 8: 'g1', 12: 'GND', 13: 'GND', 14: '+5V', 7: 'GND' }, [[38.1, 165.1], [114.3, 165.1], [190.5, 165.1], [266.7, 165.1], [355.6, 165.1]]);
  await add('74xx:74LS32', 'U4', '74LS32', { 1: 'Z', 2: 'e1', 3: 'e', 4: 'f1', 5: 'f2', 6: 'f12', 9: 'f12', 10: 'yz', 8: 'f', 12: 'g0', 13: 'g1', 11: 'g', 14: '+5V', 7: 'GND' }, [[38.1, 200.66], [114.3, 200.66], [190.5, 200.66], [266.7, 200.66], [355.6, 200.66]]);
  for (let i = 0; i < 7; i++) await add('Device:R', `R${i + 1}`, '330', { 1: 'abcdefg'[i], 2: `LED_${'abcdefg'[i]}` }, [[30.48 + i * 38.1, 251.46]]);
  for (let i = 0; i < 3; i++) await add('Device:C', `C${i + 1}`, '100n', { 1: '+5V', 2: 'GND' }, [[312.42 + i * 27.94, 236.22]]);
  for (const [text, y] of [
    ['LAB 3 - BCD TO COMMON-ANODE 7-SEGMENT DISPLAY', 15.24],
    ['WXYZ weights 8,4,2,1. Closed switch = 0; open = 1. Equal net labels are connected. 0 lights a segment.', 22.86],
    ['L3 header positions follow PDF top-to-bottom (not internal IC pins). Position 7 reserved. Inputs 10-15: do not care.', 30.48],
    ['e = Z + X Yn     f = Wn Xn Z + Xn Y + Y Z     g = Wn Xn Yn + X Y Z     n denotes NOT', 104.14],
    ['Seven individual 330-ohm segment resistors. Display pinout shown is SA39-11EWA; check your actual display.', 276.86],
  ] as [string, number][]) sch = parseSchematic(appendTopLevel(sch, `(text "${text}" (at 15.24 ${y} 0) (effects (font (size 1.524 1.524)) (justify left)) (uuid "${crypto.randomUUID()}"))`), project);
  return sch.text;
}
