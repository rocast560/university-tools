// MCP tools over the Service. One McpServer per HTTP request (stateless) and
// one for the stdio entry point. Text content is written for a reader; the
// same facts go into structuredContent for programs.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { holeName, parseHole } from '../src/layout/board.ts';
import type { Hole } from '../src/layout/types.ts';
import { displayName, isUnconnected } from '../src/netlist.ts';
import { PART_ALIASES, resolveAlias } from '../src/parts/aliases.ts';
import { summarize } from '../src/pipeline.ts';
import { renderSvg } from '../src/render/index.ts';
import { summaryOf } from './api.ts';
import { APP_NAME, APP_VERSION, PUBLIC_URL } from './config.ts';
import { pngAvailable, renderPng } from './png.ts';
import { ServiceError, type OpenProject, type Service } from './service.ts';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const text = (t: string): Content => ({ type: 'text', text: t });
const image = (data: string, mimeType: string): Content => ({ type: 'image', data, mimeType });
const fail = (message: string) => ({ isError: true as const, content: [text(message)], structuredContent: { ok: false, error: message } });
const project = z.string().describe('Project id from open_schematic, or the absolute path of the .kicad_sch.');

/** Accept "A" or "/A" or "+5V" and return the exact net name in the design. */
export function resolveNet(p: OpenProject, name: string): string {
  if (p.design.nets.has(name)) return name;
  const hit = [...p.design.nets.keys()].find((n) => displayName(n) === name || displayName(n).toLowerCase() === name.toLowerCase());
  if (!hit) throw new ServiceError(`no net "${name}". Nets: ${[...p.design.nets.keys()].filter((n) => !isUnconnected(n)).map(displayName).join(', ')}`, 404);
  return hit;
}

export function checksText(p: OpenProject): string {
  const lines = p.doc.checks.map((c) => `${c.level.toUpperCase()}: ${c.message}`);
  return lines.length ? lines.join('\n') : 'no checks';
}

export function reminder(): string {
  return `Web view: ${PUBLIC_URL}/#/p/<id>. Hole names: rows a-e top half, f-j bottom half, columns from 1; rails T+ T- B+ B-.`;
}

export function createMcpServer(service: Service): McpServer {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    {
      instructions:
        'Circuit AI Tool turns a KiCad schematic into a breadboard wiring diagram with a build guide, wiring checks and a logic simulator, and can edit the schematic. ' +
        'Start with open_schematic (absolute path) or list_projects. Layout tools (move_part, set_layout_options, set_net_color, reset_layout) change only where parts sit on the board, never the circuit. ' +
        'Schematic tools (add_component, connect, disconnect, remove_component, set_value) change the .kicad_sch itself after making a backup. ' +
        reminder(),
    },
  );

  const open = async (idOrPath: string) => (service.has(idOrPath) ? service.get(idOrPath) : service.open(idOrPath));
  const guard = <T,>(fn: () => Promise<T> | T) => async () => {
    try {
      return await fn();
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };

  server.registerTool('list_projects', { title: 'List schematics', description: 'Recently opened schematics and every .kicad_sch found in the KiCad projects folder, with ids and paths.', inputSchema: {}, annotations: { readOnlyHint: true } }, guard(async () => {
    const { recent, found } = await service.list();
    const lines = ['Recent:', ...recent.map((p) => `  ${p.id}  ${p.name}  ${p.path}`), 'Found in the projects folder:', ...found.map((f) => `  ${f.name}  ${f.path}`)];
    return { content: [text(lines.join('\n'))], structuredContent: { recent, found } };
  }));

  server.registerTool('open_schematic', { title: 'Open a schematic', description: 'Open a .kicad_sch by absolute path (or a known id), export its netlist through kicad-cli, lay it out on a breadboard and run the checks. Returns the id used by every other tool.', inputSchema: { path: z.string().describe('Absolute path to the .kicad_sch, or a project id') } }, ({ path }) => guard(async () => {
    const p = await service.open(path);
    const s = summaryOf(p);
    return { content: [text(`Opened ${p.info.name} (id ${p.info.id}).\n${s.summary}\n${reminder()}`)], structuredContent: { ...s, ok: true } };
  })());

  server.registerTool('refresh', { title: 'Re-read the schematic', description: 'Re-read the file from disk after it changed in KiCad and rebuild the layout.', inputSchema: { project } }, ({ project: id }) => guard(async () => {
    const p = await service.refresh((await open(id)).info.id);
    return { content: [text(summarize(p.doc))], structuredContent: summaryOf(p) };
  })());

  server.registerTool('get_summary', { title: 'Summary', description: 'Components, nets, board size, check counts and unplaced parts of an open project.', inputSchema: { project }, annotations: { readOnlyHint: true } }, ({ project: id }) => guard(async () => {
    const p = await open(id);
    const s = summaryOf(p);
    const comps = s.components.map((c) => `${c.ref} ${c.value} (${c.lib}:${c.part}, ${c.footprint})`).join('; ');
    return { content: [text(`${s.summary}\nComponents: ${comps}\nNets: ${s.nets.map(displayName).join(', ')}`)], structuredContent: s };
  })());

  server.registerTool('get_layout', { title: 'Full layout JSON', description: 'The whole layout document: board, packages, parts, wires, pin holes, nets, steps, pinouts, checks, simulation model.', inputSchema: { project }, annotations: { readOnlyHint: true } }, ({ project: id }) => guard(async () => {
    const p = await open(id);
    return { content: [text(JSON.stringify(p.doc))], structuredContent: p.doc as unknown as Record<string, unknown> };
  })());

  server.registerTool('render_breadboard', { title: 'Picture of the breadboard', description: 'PNG of the wired breadboard. Optionally highlight one net, one part, or one build step (everything else is dimmed).', inputSchema: { project, highlight_net: z.string().optional().describe('Net name, e.g. "A" or "+5V"'), highlight_ref: z.string().optional().describe('Part reference, e.g. "U1"'), highlight_step: z.number().int().optional().describe('Build step number') }, annotations: { readOnlyHint: true } }, ({ project: id, highlight_net, highlight_ref, highlight_step }) => guard(async () => {
    const p = await open(id);
    let highlight = null;
    if (highlight_net) highlight = { net: resolveNet(p, highlight_net) };
    else if (highlight_ref) highlight = { ref: highlight_ref };
    else if (highlight_step) {
      const step = p.doc.steps.find((s) => s.n === highlight_step);
      if (!step) return fail(`no step ${highlight_step}; there are ${p.doc.steps.length}`);
      highlight = step.wire !== undefined ? { wire: step.wire } : step.ref ? { ref: step.ref } : null;
    }
    const svg = renderSvg(p.doc, { highlight });
    const caption = `${p.info.name}: ${summarize(p.doc).split('\n')[0]}${highlight ? ` Highlighted: ${JSON.stringify(highlight)}.` : ''}`;
    if (!pngAvailable()) return { content: [text(caption), text(svg)] };
    return { content: [image(Buffer.from(renderPng(svg)).toString('base64'), 'image/png'), text(caption)] };
  })());

  server.registerTool('render_schematic', { title: 'Picture of the schematic', description: 'PNG of the KiCad schematic itself, exported through kicad-cli.', inputSchema: { project }, annotations: { readOnlyHint: true } }, ({ project: id }) => guard(async () => {
    const p = await open(id);
    const svg = await service.schematicSvg(p.info.id);
    if (!pngAvailable()) return { content: [text(svg)] };
    return { content: [image(Buffer.from(renderPng(svg, 2000)).toString('base64'), 'image/png'), text(`Schematic of ${p.info.name}`)] };
  })());

  server.registerTool('get_build_steps', { title: 'Build steps', description: 'Numbered wiring steps grouped by phase, naming every hole.', inputSchema: { project }, annotations: { readOnlyHint: true } }, ({ project: id }) => guard(async () => {
    const p = await open(id);
    return { content: [text(p.doc.steps.map((s) => `${s.n}. [${s.phase}] ${s.label}`).join('\n'))], structuredContent: { steps: p.doc.steps } };
  })());

  server.registerTool('get_checks', { title: 'Checks', description: 'Wiring, power, polarity and DC checks with severity.', inputSchema: { project }, annotations: { readOnlyHint: true } }, ({ project: id }) => guard(async () => {
    const p = await open(id);
    return { content: [text(checksText(p))], structuredContent: { checks: p.doc.checks, errors: p.doc.checks.filter((c) => c.level === 'error').length } };
  })());

  server.registerTool('get_truth_table', { title: 'Truth table', description: 'Truth table over the switch-controlled inputs, with LED states, when the wiring passes the checks.', inputSchema: { project }, annotations: { readOnlyHint: true } }, ({ project: id }) => guard(async () => {
    const p = await open(id);
    const t = p.doc.sim.truthTable;
    if (!t) return { content: [text(`No truth table: ${p.doc.sim.note ?? 'unknown reason'}`)], structuredContent: { note: p.doc.sim.note } };
    const header = `${t.inputs.join('  ')}  |  ${t.outputs.join('  ')}  |  ${t.leds.join('  ')}`;
    const rows = t.rows.map((r) => `${r.inputs.join('  ')}  |  ${r.outputs.join('  ')}  |  ${r.leds.map((l) => (l ? 'on' : 'off')).join(' ')}`);
    return { content: [text([header, '-'.repeat(header.length), ...rows, p.doc.sim.note ? `Note: ${p.doc.sim.note}` : ''].join('\n'))], structuredContent: t as unknown as Record<string, unknown> };
  })());

  server.registerTool('get_pinout', { title: 'Chip pinout', description: 'Every pin of a chip: function, net and the breadboard hole it sits in.', inputSchema: { project, ref: z.string().describe('Chip reference, e.g. "U1"') }, annotations: { readOnlyHint: true } }, ({ project: id, ref }) => guard(async () => {
    const p = await open(id);
    const po = p.doc.pinouts.find((x) => x.ref === ref);
    if (!po) return fail(`no chip ${ref}; chips: ${p.doc.pinouts.map((x) => x.ref).join(', ') || 'none'}`);
    return { content: [text(`${po.ref} ${po.name}\n` + po.pins.map((x) => `pin ${x.num} ${x.function}${x.net ? ` = ${x.net}` : ' (unused)'}${x.hole ? `, hole ${x.hole}` : ''}`).join('\n'))], structuredContent: po as unknown as Record<string, unknown> };
  })());

  server.registerTool('explain_net', { title: 'Explain a net', description: 'Which pins, holes and jumper wires carry a net on the board.', inputSchema: { project, net: z.string().describe('Net name, e.g. "A", "Y1", "+5V"') }, annotations: { readOnlyHint: true } }, ({ project: id, net }) => guard(async () => {
    const p = await open(id);
    const name = resolveNet(p, net);
    const pins = (p.design.nets.get(name) ?? []).map((m) => {
      const h = p.doc.pinHoles[m.ref]?.[m.pin];
      return `${m.ref} pin ${m.pin}${h ? ` in ${holeName(h)}` : ' (not placed)'}`;
    });
    const wires = p.doc.wires.map((w, i) => ({ w, i })).filter(({ w }) => w.net === name).map(({ w, i }) => `wire ${i + 1}: ${holeName(w.a)} to ${holeName(w.b)} (${w.role})`);
    const info = p.doc.nets[name];
    return { content: [text(`Net ${displayName(name)}${info ? ` (colour ${info.color}${info.power ? `, ${info.power === 'gnd' ? 'ground' : 'supply'}` : ''})` : ''}\nPins: ${pins.join('; ')}\n${wires.length ? wires.join('\n') : 'No jumper wires (all pins share a strip or a rail).'}`)], structuredContent: { net: name, pins, wires } };
  })());

  server.registerTool('simulate', { title: 'Simulate', description: 'Logic levels of every net and the LED states for the given input levels (nets not given keep their idle level: switches open).', inputSchema: { project, levels: z.record(z.string(), z.union([z.literal(0), z.literal(1)])).describe('Net name -> 0 or 1, e.g. {"A": 1, "B": 0}') }, annotations: { readOnlyHint: true } }, ({ project: id, levels }) => guard(async () => {
    const p = await open(id);
    const mapped: Record<string, 0 | 1> = {};
    for (const [k, v] of Object.entries(levels)) mapped[resolveNet(p, k)] = v;
    const r = service.simulate(p.info.id, mapped);
    const outs = Object.entries(r.nets).filter(([n]) => !isUnconnected(n) && !n.startsWith('Net-(')).map(([n, v]) => `${displayName(n)} = ${v}`);
    const leds = Object.entries(r.leds).map(([ref, on]) => `${ref} ${on ? 'on' : 'off'}`);
    return { content: [text(`${outs.join(', ')}\nLEDs: ${leds.join(', ') || 'none'}`)], structuredContent: r as unknown as Record<string, unknown> };
  })());

  server.registerTool('list_supported_parts', { title: 'Supported parts', description: 'Part names and KiCad lib_ids that add_component accepts and the layout engine can place.', inputSchema: {}, annotations: { readOnlyHint: true } }, guard(async () => ({ content: [text(PART_ALIASES.map((a) => `${a.alias}  (${a.libId})  ${a.description}`).join('\n'))], structuredContent: { parts: PART_ALIASES } })));

  server.registerTool('set_layout_options', { title: 'Layout options', description: 'Board size, rail split, folding separate switches into one DIP switch, chip order, value substitutions. Layout only; the circuit is unchanged.', inputSchema: { project, board: z.enum(['auto', 'half', 'full']).optional(), railSplit: z.boolean().nullable().optional(), dipSwitchPositions: z.number().int().min(0).max(16).optional().describe('0 = separate switches; N = fold them into an N-position DIP switch'), packageOrder: z.array(z.string()).optional(), substitutions: z.record(z.string(), z.string()).optional().describe('ref -> value shown on the board') } }, ({ project: id, ...patch }) => guard(async () => {
    const p = await service.setOptions((await open(id)).info.id, patch);
    return { content: [text(`Options now ${JSON.stringify(p.sidecar.options)}. ${p.doc.packages.some((x) => x.kind === 'dipswitch') ? 'The board uses a DIP switch. ' : ''}${summarize(p.doc)}`)], structuredContent: { options: p.sidecar.options, checks: p.doc.checks } };
  })());

  server.registerTool('move_part', { title: 'Move a part', description: 'Pin every leg of a part to given holes ("a12", "T+3"). Wires re-route. Fails if a hole is taken or off the board.', inputSchema: { project, ref: z.string(), holes: z.record(z.string(), z.string()).describe('pin number -> hole name, e.g. {"1": "a12", "2": "a15"}') } }, ({ project: id, ref, holes }) => guard(async () => {
    const parsed: Record<string, Hole> = {};
    for (const [pin, h] of Object.entries(holes)) parsed[pin] = parseHole(h);
    const p = await service.movePart((await open(id)).info.id, ref, parsed);
    const now = Object.values(p.doc.pinHoles[ref]).map(holeName).join(' and ');
    return { content: [text(`${ref} now at ${now}.\n${checksText(p)}`)], structuredContent: { pinHoles: p.doc.pinHoles[ref], checks: p.doc.checks } };
  })());

  server.registerTool('set_net_color', { title: 'Net colour', description: 'Colour of the jumper wires of a net (#rrggbb), or null to go back to the default.', inputSchema: { project, net: z.string(), color: z.string().nullable() } }, ({ project: id, net, color }) => guard(async () => {
    const p0 = await open(id);
    const p = await service.setColor(p0.info.id, resolveNet(p0, net), color);
    return { content: [text(`${displayName(net)} wires are now ${p.doc.nets[resolveNet(p, net)].color}.`)], structuredContent: { colors: p.sidecar.colors } };
  })());

  server.registerTool('reset_layout', { title: 'Reset layout', description: 'Forget pinned placements, options and colours; lay the board out automatically again.', inputSchema: { project } }, ({ project: id }) => guard(async () => {
    const p = await service.resetLayout((await open(id)).info.id);
    return { content: [text(summarize(p.doc))], structuredContent: { checks: p.doc.checks } };
  })());

  server.registerTool('run_erc', { title: 'KiCad ERC', description: 'Run KiCad electrical rules check on the schematic and return the violations.', inputSchema: { project } }, ({ project: id }) => guard(async () => {
    const p = await open(id);
    const erc = (await service.erc(p.info.id)) as { sheets?: { violations?: { severity: string; description: string }[] }[] };
    const violations = (erc.sheets ?? []).flatMap((s) => s.violations ?? []);
    return { content: [text(violations.length ? violations.map((v) => `${v.severity}: ${v.description}`).join('\n') : 'ERC: no violations')], structuredContent: erc as Record<string, unknown> };
  })());

  const editText = (out: Awaited<ReturnType<Service['setValue']>>) => `${out.notes.join('\n')}\nBackup: ${out.backup}\n${checksText(out.project)}`;
  const editStructured = (out: Awaited<ReturnType<Service['setValue']>>) => ({ ok: true, ref: out.ref, unit: out.unit, backup: out.backup, notes: out.notes, checks: out.project.doc.checks });

  server.registerTool('add_component', { title: 'Add a component', description: 'Add a part to the schematic (and therefore the breadboard). "part" is a name from list_supported_parts ("LED", "10k" is not a part: give value separately) or a KiCad lib_id ("Device:R"). Optional connections map pin numbers to net names; power nets get a power symbol, other nets a label. For 74xx gates a spare gate of an existing chip is reused when possible.', inputSchema: { project, part: z.string().describe('Alias like "resistor", "LED", "74LS00", or lib_id like "Device:R"'), value: z.string().optional().describe('Value shown, e.g. "10k", "100n", "74LS00"'), ref: z.string().optional().describe('Reference to use; default: next free (R5, U4, ...)'), connections: z.record(z.string(), z.string()).optional().describe('pin number -> net name, e.g. {"1": "A", "2": "+5V"}') } }, ({ project: id, part, value, ref, connections }) => guard(async () => {
    const alias = resolveAlias(part);
    const libId = alias?.libId ?? (part.includes(':') ? part : null);
    if (!libId) return fail(`unknown part "${part}"; call list_supported_parts for names, or give a KiCad lib_id like Device:R`);
    const out = await service.addComponent((await open(id)).info.id, { libId, value: value ?? alias?.defaultValue, ref, connections });
    return { content: [text(editText(out))], structuredContent: editStructured(out) };
  })());

  server.registerTool('connect', { title: 'Connect a pin to a net', description: 'Join a pin to a net by placing a label (or a power symbol for +5V, GND and the like) on the pin in the schematic. Use an existing net name to join it, or a new name to start a net.', inputSchema: { project, ref: z.string(), pin: z.string().describe('Pin number as printed on the package, e.g. "3"'), net: z.string().describe('Net name, e.g. "A", "Y1", "+5V", "GND", or a new name') } }, ({ project: id, ref, pin, net }) => guard(async () => {
    const out = await service.connect((await open(id)).info.id, ref, pin, net);
    return { content: [text(editText(out))], structuredContent: editStructured(out) };
  })());

  server.registerTool('disconnect', { title: 'Disconnect a pin', description: 'Remove the labels or power symbols this tool placed on a pin. Wires and labels drawn by hand in KiCad are left alone and reported.', inputSchema: { project, ref: z.string(), pin: z.string() } }, ({ project: id, ref, pin }) => guard(async () => {
    const out = await service.disconnect((await open(id)).info.id, ref, pin);
    return { content: [text(editText(out))], structuredContent: editStructured(out) };
  })());

  server.registerTool('remove_component', { title: 'Remove a component', description: 'Delete every unit of a component and the labels this tool placed on it.', inputSchema: { project, ref: z.string() } }, ({ project: id, ref }) => guard(async () => {
    const out = await service.removeComponent((await open(id)).info.id, ref);
    return { content: [text(editText(out))], structuredContent: editStructured(out) };
  })());

  server.registerTool('set_value', { title: 'Set a value', description: 'Change the Value field of a component (all units), e.g. R1 to "2k2" or U2 to "74HC04".', inputSchema: { project, ref: z.string(), value: z.string() } }, ({ project: id, ref, value }) => guard(async () => {
    const out = await service.setValue((await open(id)).info.id, ref, value);
    return { content: [text(editText(out))], structuredContent: editStructured(out) };
  })());

  return server;
}
