import { describe, expect, it } from 'vitest';
import { findCas, PubChem, PubChemUnavailable } from './pubchem.ts';

function fakeFetch(routes: Record<string, { status: number; body: string }>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return new Response('{"Fault":{}}', { status: 404 });
    return new Response(hit[1].body, { status: hit[1].status });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const props = JSON.stringify({
  PropertyTable: {
    Properties: [
      { CID: 176, MolecularFormula: 'C2H4O2', MolecularWeight: '60.05', SMILES: 'CC(=O)O', ConnectivitySMILES: 'CC(=O)O', IUPACName: 'acetic acid', Title: 'Acetic Acid' },
    ],
  },
});

describe('PubChem client', () => {
  it('looks up by name and parses properties', async () => {
    const { fetch, calls } = fakeFetch({ '/compound/name/acetic%20acid/property/': { status: 200, body: props } });
    const pc = new PubChem({ fetch, cacheDir: null, minIntervalMs: 0 });
    const [hit] = await pc.byName('acetic acid');
    expect(hit).toMatchObject({ cid: 176, formula: 'C2H4O2', weight: 60.05, smiles: 'CC(=O)O', title: 'Acetic Acid' });
    expect(calls[0]).toContain('MolecularFormula,MolecularWeight,SMILES');
  });

  it('returns an empty list for unknown names', async () => {
    const pc = new PubChem({ fetch: fakeFetch({}).fetch, cacheDir: null, minIntervalMs: 0 });
    expect(await pc.byName('xyzzy')).toEqual([]);
    expect(await pc.sdf(1, '3d')).toBeNull();
  });

  it('chains formula search into a property lookup', async () => {
    const { fetch, calls } = fakeFetch({
      '/fastformula/C2H4O2/cids/': { status: 200, body: JSON.stringify({ IdentifierList: { CID: [176, 7865] } }) },
      '/compound/cid/176,7865/property/': { status: 200, body: props },
    });
    const pc = new PubChem({ fetch, cacheDir: null, minIntervalMs: 0 });
    const hits = await pc.byFormula('C2H4O2');
    expect(hits.length).toBe(1);
    expect(calls.length).toBe(2);
  });

  it('throws PubChemUnavailable on server errors and network failures', async () => {
    const down = new PubChem({ fetch: fakeFetch({ '/name/': { status: 503, body: 'busy' } }).fetch, cacheDir: null, minIntervalMs: 0 });
    await expect(down.byName('water')).rejects.toBeInstanceOf(PubChemUnavailable);
    const broken = new PubChem({
      fetch: (async () => { throw new Error('offline'); }) as typeof fetch,
      cacheDir: null,
      minIntervalMs: 0,
    });
    await expect(broken.byName('water')).rejects.toBeInstanceOf(PubChemUnavailable);
  });

  it('spaces requests out', async () => {
    const { fetch, calls } = fakeFetch({ '/property/': { status: 200, body: props } });
    const pc = new PubChem({ fetch, cacheDir: null, minIntervalMs: 30 });
    const t0 = Date.now();
    await Promise.all([pc.byName('a'), pc.byName('b'), pc.byName('c')]);
    expect(calls.length).toBe(3);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  });

  it('dedupes concurrent identical requests', async () => {
    const { fetch, calls } = fakeFetch({ '/property/': { status: 200, body: props } });
    const pc = new PubChem({ fetch, cacheDir: null, minIntervalMs: 0 });
    await Promise.all([pc.byName('same'), pc.byName('same')]);
    expect(calls.length).toBe(1);
  });
});

describe('findCas', () => {
  it('picks the CAS shaped synonym', () => {
    expect(findCas(['acetic acid', '64-19-7', 'ethanoic acid'])).toBe('64-19-7');
    expect(findCas(['nothing'])).toBeUndefined();
  });
});
