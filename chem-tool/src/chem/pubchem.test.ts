import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PubChem, PubChemUnavailable, findCas } from './pubchem';

const props = (cid: number, formula: string, smiles: string, title: string) => JSON.stringify({
  PropertyTable: { Properties: [{ CID: cid, MolecularFormula: formula, MolecularWeight: '46.07', SMILES: smiles, ConnectivitySMILES: smiles, IUPACName: 'ethanol', Title: title }] },
});

function fakeFetch(routes: Record<string, { status: number; body: string }>, calls: string[]) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    const { status, body } = hit ? hit[1] : { status: 404, body: '{"Fault":{}}' };
    return new Response(body, { status });
  }) as typeof fetch;
}

describe('PubChem', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'pubchem-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('byName parses properties and caches on disk', async () => {
    const calls: string[] = [];
    const pc = new PubChem({ fetch: fakeFetch({ '/compound/name/ethanol/': { status: 200, body: props(702, 'C2H6O', 'CCO', 'Ethanol') } }, calls), cacheDir: dir, minIntervalMs: 0 });
    const first = await pc.byName('ethanol');
    expect(first[0]).toMatchObject({ cid: 702, formula: 'C2H6O', smiles: 'CCO', title: 'Ethanol', iupac: 'ethanol' });
    expect(first[0].weight).toBeCloseTo(46.07, 2);
    await pc.byName('ethanol');
    expect(calls).toHaveLength(1);
    expect((await readdir(dir)).length).toBe(1);
  });
  test('404 is an empty answer, 5xx throws PubChemUnavailable', async () => {
    const calls: string[] = [];
    const pc = new PubChem({ fetch: fakeFetch({ '/compound/name/broken/': { status: 503, body: 'busy' } }, calls), cacheDir: null, minIntervalMs: 0 });
    expect(await pc.byName('nothing')).toEqual([]);
    await expect(pc.byName('broken')).rejects.toBeInstanceOf(PubChemUnavailable);
  });
  test('a malformed 200 body is reported as unavailable and never cached', async () => {
    const calls: string[] = [];
    const pc = new PubChem({ fetch: fakeFetch({ '/compound/name/garbled/': { status: 200, body: '<html>maintenance</html>' } }, calls), cacheDir: dir, minIntervalMs: 0 });
    await expect(pc.byName('garbled')).rejects.toBeInstanceOf(PubChemUnavailable);
    expect(await readdir(dir)).toEqual([]);
    await expect(pc.byName('garbled')).rejects.toBeInstanceOf(PubChemUnavailable);
    expect(calls).toHaveLength(2);
  });
  test('byFormula chains cids to properties', async () => {
    const calls: string[] = [];
    const pc = new PubChem({ fetch: fakeFetch({
      '/fastformula/C2H6O/cids/': { status: 200, body: JSON.stringify({ IdentifierList: { CID: [702, 8254] } }) },
      '/compound/cid/702,8254/property/': { status: 200, body: props(702, 'C2H6O', 'CCO', 'Ethanol') },
    }, calls), cacheDir: null, minIntervalMs: 0 });
    const hits = await pc.byFormula('C2H6O');
    expect(hits.map((h) => h.cid)).toEqual([702]);
  });
  test('sdf returns text or null', async () => {
    const pc = new PubChem({ fetch: fakeFetch({ '/compound/cid/702/SDF?record_type=3d': { status: 200, body: 'mol\n  3D\n' } }, []), cacheDir: null, minIntervalMs: 0 });
    expect(await pc.sdf(702, '3d')).toContain('3D');
    expect(await pc.sdf(1, '3d')).toBeNull();
  });
  test('network failure throws PubChemUnavailable', async () => {
    const pc = new PubChem({ fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch, cacheDir: null, minIntervalMs: 0 });
    await expect(pc.byName('water')).rejects.toThrow(/offline/);
  });
  test('findCas picks the CAS-shaped synonym', () => {
    expect(findCas(['ethanol', '64-17-5', 'alcohol'])).toBe('64-17-5');
    expect(findCas(['ethanol'])).toBeUndefined();
  });
});
