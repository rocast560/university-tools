import type { KicadCli } from '../server/kicad-cli.ts';

export function fakeKicad(netText: string): KicadCli {
  return {
    available: async () => true,
    netlist: async () => netText,
    svg: async () => '<svg xmlns="http://www.w3.org/2000/svg"><text>fake schematic</text></svg>',
    erc: async () => ({ violations: [], sheets: [] }),
  };
}
