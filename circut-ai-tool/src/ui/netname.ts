// Short names for the net legend: an auto-named net `Net-(R7-Pad1)` shows as
// `R7` when it is the only net on that part, else `R7-Pad1`. Labelled and
// power nets keep their names.

import { displayName } from '../netlist.ts';

const AUTO = /^Net-\(([^-)]+)-([^)]*)\)$/;

export function shortNet(net: string, nets: string[]): string {
  const name = displayName(net);
  const m = AUTO.exec(name);
  if (!m) return name;
  const [, ref, pin] = m;
  const shared = nets.some((other) => {
    if (other === net) return false;
    const o = AUTO.exec(displayName(other));
    return o !== null && o[1] === ref;
  });
  return shared ? `${ref}-${pin}` : ref;
}
