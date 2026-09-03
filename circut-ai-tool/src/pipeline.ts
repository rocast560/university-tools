// design + sidecar -> LayoutDoc. Pure; the server and the client call this.

import { hasErrors, runChecks, type Check } from './checks/index.ts';
import { buildPartsList, buildPinouts, buildSteps, type Pinout, type Step } from './guide.ts';
import { layout, type EngineResult } from './layout/engine.ts';
import type { Sidecar } from './layout/types.ts';
import type { Design } from './netlist.ts';
import { buildSimModel, truthTable, type SimModel, type TruthTable } from './sim/index.ts';

export interface LayoutDoc extends EngineResult {
  steps: Step[];
  pinouts: Pinout[];
  partsList: string[];
  checks: Check[];
  sim: { model: SimModel; truthTable: TruthTable | null; note: string | null };
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
  return { ...res, steps: buildSteps(design, res, model), pinouts: buildPinouts(design, res), partsList: buildPartsList(res), checks, sim: { model, truthTable: table, note } };
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
