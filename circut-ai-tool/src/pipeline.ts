// design + sidecar -> LayoutDoc. Pure; the server and the client call this.

import { hasErrors, runChecks, type Check } from './checks/index.ts';
import { buildPartsList, buildPinouts, buildSteps, type Pinout, type Step } from './guide.ts';
import { layout, type EngineResult } from './layout/engine.ts';
import type { Sidecar } from './layout/types.ts';
import type { Design } from './netlist.ts';
import { wirePolylines } from './render/ortho.ts';
import { routeWires, type RouteResult, type WireRoute } from './render/route3d.ts';
import { buildSimModel, truthTable, type SimModel, type TruthTable } from './sim/index.ts';

export interface LayoutDoc extends EngineResult {
  steps: Step[];
  pinouts: Pinout[];
  partsList: string[];
  checks: Check[];
  sim: { model: SimModel; truthTable: TruthTable | null; note: string | null };
  /**
   * Square-cornered jumper routes, one per wire, present only when the
   * sidecar asks for square wires. The flat board and the 3D board both draw
   * these, so the two views always agree.
   */
  routes?: WireRoute[];
}

/** What buildLayoutDoc routes with. Test-only seam: a test swaps `route` to make the router throw. */
export const router: { route: typeof routeWires } = { route: routeWires };

/** Said on every wire, and in the checks, when the router itself fails. */
export const ROUTER_FAILED = 'the wire router failed; showing simple square wires';

/**
 * Route the square wires. The router is not meant to throw, but a layout must
 * never fail for want of pretty wires (spec section 7): if it does throw,
 * every wire is drawn by the simple corridor router instead, flagged so the
 * editor offers no handles for it.
 */
function routeSafely(res: EngineResult, sidecar: Sidecar): RouteResult {
  try {
    return router.route(res, sidecar.wirePaths ?? {});
  } catch {
    return { routes: wirePolylines(res.wires, res.packages, res.board).map((plan) => ({ plan, lifts: [], warning: ROUTER_FAILED })), warnings: [ROUTER_FAILED] };
  }
}

export function buildLayoutDoc(design: Design, sidecar: Sidecar): LayoutDoc {
  const res = layout(design, sidecar);
  const checks = runChecks(design, res);
  const model = buildSimModel(design, res);
  let table: TruthTable | null = null;
  let note: string | null = null;
  if (hasErrors(checks)) note = 'the wiring has errors, so the simulation is withheld until they are fixed';
  else if (!model.inputs.length) note = 'no switch-controlled inputs; nothing to tabulate';
  else if (model.inputs.length > 6) note = `${model.inputs.length} inputs is too many for a truth table (limit 6); use simulate with explicit levels`;
  else table = truthTable(model);
  if (!note && model.notSimulated.length) note = `not simulated: ${model.notSimulated.join(', ')}`;
  const doc: LayoutDoc = { ...res, steps: buildSteps(design, res, model), pinouts: buildPinouts(design, res), partsList: buildPartsList(res), checks, sim: { model, truthTable: table, note } };
  if (sidecar.options.wireStyle !== 'orthogonal') return doc;
  // Routed here rather than at draw time so every view draws the one set of
  // paths, and so what the router had to say (a stale or no-longer-fitting
  // hand shape, a wire with no clean route) reaches doc.warnings and, as
  // layout warnings, the checks: the Checks panel, the warning counts and
  // the MCP summaries all read doc.checks. The checks ran before routing,
  // so these are appended.
  const routed = routeSafely(res, sidecar);
  const more: Check[] = routed.warnings.map((message) => ({ id: 'layout', level: 'warning', message, refs: [] }));
  return { ...doc, checks: [...checks, ...more], routes: routed.routes, warnings: [...res.warnings, ...routed.warnings] };
}

export function summarize(doc: LayoutDoc): string {
  const errors = doc.checks.filter((c) => c.level === 'error').length;
  const warnings = doc.checks.filter((c) => c.level === 'warning').length;
  const chips = doc.packages.filter((p) => p.kind === 'dip').length;
  const lines = [
    `${doc.board.kind}-size breadboard (${doc.board.cols} columns${doc.board.splitCol ? ', split rails' : ''}); ${chips} chips, ${doc.packages.length - chips} other packages, ${doc.parts.length} two- and three-lead parts, ${doc.wires.length} jumper wires.`,
    `Checks: ${errors} errors, ${warnings} warnings.` + (errors ? ' ' + doc.checks.filter((c) => c.level === 'error').map((c) => c.message).join(' ') : ''),
  ];
  if (doc.unplaced.length) lines.push(`Not placed: ${doc.unplaced.map((u) => `${u.ref} (${u.reason})`).join('; ')}.`);
  if (doc.sim.truthTable) lines.push(`Truth table: inputs ${doc.sim.truthTable.inputs.join(', ')}; outputs ${doc.sim.truthTable.outputs.join(', ')}.`);
  if (doc.sim.note) lines.push(`Simulation: ${doc.sim.note}.`);
  return lines.join('\n');
}
