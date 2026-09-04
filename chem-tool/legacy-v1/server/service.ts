// Everything the REST routes and the MCP tools share: resolving a query,
// turning a resolved record into each output format, and the public
// summary shape. Keeping this in one place means an MCP client and a
// browser always get identical answers for the same question.

import { balanceEquation } from '../src/chem/balance.ts';
import { composition, formatFormulaHtml, formatFormulaUnicode, molarMass, parseFormula } from '../src/chem/formula.ts';
import { buildLattice, cellEdges, findLattice, LATTICE_MATERIALS, type LatticeCluster } from '../src/chem/lattice.ts';
import { library } from '../src/chem/library.ts';
import { bakeSvgTheme, svgToPng } from '../src/chem/png.ts';
import { renderStructureSvg, type RenderStyle } from '../src/chem/render3d.ts';
import { resolver, type ResolveResult } from '../src/chem/resolve.ts';
import { molfileToStructure, structureToMolfile, structureToPdb, structureToXyz, type Structure3D } from '../src/chem/structure.ts';
import type { LibraryEntry } from '../src/chem/types.ts';
import { PUBLIC_URL } from './config.ts';

export type Theme = 'light' | 'dark';

export async function resolveQuery(q: string): Promise<ResolveResult> {
  return resolver().resolve(q);
}

/** Links a client can follow for every representation of a query. */
export function linksFor(q: string): Record<string, string> {
  const e = encodeURIComponent(q);
  return {
    page: `${PUBLIC_URL}/?q=${e}`,
    json: `${PUBLIC_URL}/api/molecule?q=${e}`,
    svg2d: `${PUBLIC_URL}/api/molecule/2d.svg?q=${e}`,
    png2d: `${PUBLIC_URL}/api/molecule/2d.png?q=${e}`,
    sdf: `${PUBLIC_URL}/api/molecule/3d.sdf?q=${e}`,
    xyz: `${PUBLIC_URL}/api/molecule/3d.xyz?q=${e}`,
    pdb: `${PUBLIC_URL}/api/molecule/3d.pdb?q=${e}`,
    svg3d: `${PUBLIC_URL}/api/molecule/3d.svg?q=${e}`,
    png3d: `${PUBLIC_URL}/api/molecule/3d.png?q=${e}`,
  };
}

export function structureOf(molfile: string | null): Structure3D | null {
  return molfile ? molfileToStructure(molfile) : null;
}

export interface SnapshotOptions {
  style?: RenderStyle;
  labels?: boolean;
  width?: number;
  height?: number;
  theme?: Theme;
  rotate?: { x?: number; y?: number; z?: number };
  lines?: Array<{ from: [number, number, number]; to: [number, number, number]; color?: string }>;
}

/** 3D snapshot as SVG with a solid themed background. */
export function snapshotSvg(structure: Structure3D, options: SnapshotOptions = {}): string {
  const theme = options.theme ?? 'light';
  return renderStructureSvg(structure, {
    width: options.width ?? 640,
    height: options.height ?? 480,
    style: options.style ?? 'ballstick',
    labels: options.labels ?? false,
    rotate: options.rotate,
    background: theme === 'dark' ? '#16181d' : '#ffffff',
    foreground: theme === 'dark' ? '#e8e8e8' : '#1a1a1a',
    lines: options.lines,
  });
}

export function snapshotPng(structure: Structure3D, options: SnapshotOptions = {}): Uint8Array<ArrayBuffer> {
  return svgToPng(snapshotSvg(structure, options));
}

/** 2D depiction with colours baked in, as SVG or PNG. */
export function depiction2dSvg(svg: string, theme: Theme): string {
  return bakeSvgTheme(svg, theme);
}

export function depiction2dPng(svg: string, theme: Theme, width = 640): Uint8Array<ArrayBuffer> {
  return svgToPng(bakeSvgTheme(svg, theme), width);
}

export function toXyz(structure: Structure3D, name: string): string {
  return structureToXyz(structure, name);
}

export function toPdb(structure: Structure3D, name: string): string {
  return structureToPdb(structure, name);
}

export function formulaInfo(formula: string) {
  const parsed = parseFormula(formula);
  const mass = molarMass(parsed.counts);
  return {
    input: formula,
    formula: parsed.hill,
    formulaHtml: formatFormulaHtml(formula),
    formulaUnicode: formatFormulaUnicode(formula),
    counts: parsed.counts,
    charge: parsed.charge,
    coefficient: parsed.coefficient,
    molarMass: Math.round(mass * 1000) / 1000,
    composition: composition(parsed.counts).map((c) => ({ ...c, mass: Math.round(c.mass * 1000) / 1000, massPercent: Math.round(c.massPercent * 100) / 100 })),
    knownCompounds: library().findByHill(parsed.hill).map(summary),
  };
}

export function balance(equation: string) {
  const r = balanceEquation(equation);
  return {
    input: equation,
    equation: r.equation,
    ascii: r.ascii,
    coefficients: r.coefficients,
    reactants: r.reactants.map((s) => ({ formula: s.formula, coefficient: s.coefficient })),
    products: r.products.map((s) => ({ formula: s.formula, coefficient: s.coefficient })),
  };
}

/** Light record for lists and search results. */
export function summary(e: LibraryEntry) {
  return {
    id: e.id,
    name: e.name,
    formula: e.formula,
    formulaHtml: formatFormulaHtml(e.formula),
    formulaUnicode: formatFormulaUnicode(e.formula),
    molarMass: e.molarMass,
    category: e.category,
    kind: e.kind,
    note: e.note,
  };
}

export interface LatticeResult {
  cluster: LatticeCluster;
  molfile: string;
  edges: Array<[[number, number, number], [number, number, number]]>;
}

export function latticeFor(material: string, repeat = 2): LatticeResult | null {
  const spec = findLattice(material);
  if (!spec) return null;
  const r = Math.max(1, Math.min(4, Math.round(repeat)));
  const cluster = buildLattice(spec, r);
  return { cluster, molfile: structureToMolfile(cluster, spec.name), edges: cellEdges(cluster.cell, r) };
}

export function latticeList() {
  return LATTICE_MATERIALS.map((m) => ({ name: m.name, formula: m.formula, type: m.type, a: m.a, c: m.c, aliases: m.aliases ?? [], note: m.note }));
}

export function latticeSummary(r: LatticeResult) {
  const { cluster } = r;
  return {
    name: cluster.spec.name,
    formula: cluster.spec.formula,
    type: cluster.spec.type,
    title: cluster.title,
    note: cluster.spec.note,
    a: cluster.spec.a,
    c: cluster.spec.c,
    repeat: cluster.repeat,
    atomsShown: cluster.atoms.length,
    atomsPerCell: cluster.atomsPerCell,
    coordination: cluster.coordination,
    packingFactor: cluster.packingFactor,
    elements: cluster.spec.elements,
  };
}

/** Plain text description of a resolved compound for chat clients. */
export function describe(result: Extract<ResolveResult, { ok: true }>): string {
  const r = result.resolved;
  const c = r.compound;
  const lines = [
    `${c.name} (${c.formulaUnicode})`,
    `Molar mass: ${c.molarMass} g/mol`,
  ];
  if (c.iupac && c.iupac.toLowerCase() !== c.name.toLowerCase()) lines.push(`IUPAC name: ${c.iupac}`);
  if (c.smiles) lines.push(`SMILES: ${c.smiles}`);
  if (c.cas) lines.push(`CAS: ${c.cas}`);
  if (c.cid) lines.push(`PubChem CID: ${c.cid} (${c.pubchemUrl})`);
  if (c.charge) lines.push(`Charge: ${c.charge > 0 ? '+' : ''}${c.charge}`);
  lines.push(`Kind: ${c.kind}; category: ${c.category}${c.tags.length ? ` (${c.tags.join(', ')})` : ''}`);
  if (c.aliases.length) lines.push(`Also called: ${c.aliases.slice(0, 8).join(', ')}`);
  if (c.note) lines.push(c.note);
  if (r.composition.length) {
    lines.push('Composition: ' + r.composition.map((x) => `${x.symbol} ${x.count} (${x.massPercent.toFixed(1)}%)`).join(', '));
  }
  if (r.alternatives.length) {
    lines.push(`Other compounds with formula ${c.hill}: ` + r.alternatives.slice(0, 6).map((a) => `${a.name} (${a.formulaUnicode})`).join(', '));
  }
  if (r.lattice) lines.push(`Crystal structure: ${r.lattice.title}, a = ${r.lattice.a} Å, coordination ${r.lattice.coordination}${r.lattice.packingFactor ? `, packing factor ${r.lattice.packingFactor}` : ''}.`);
  lines.push(`3D structure: ${r.structureSource === 'none' ? 'not available' : r.structureSource}. Matched on ${r.matchedOn}; source: ${c.source}.`);
  for (const w of r.warnings) lines.push(`Note: ${w}`);
  lines.push(`Open in the app: ${linksFor(r.query).page}`);
  return lines.join('\n');
}
