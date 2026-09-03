// PubChem PUG REST client. The only module in src/chem that talks to the network.
// At most 5 requests per second (210 ms spacing). 200 and 404 answers are cached on disk so a
// repeated lookup never hits the network twice; errors are not cached.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';

export interface PubChemCompound {
  cid: number;
  formula: string;
  weight: number;
  smiles: string;
  connectivitySmiles: string;
  iupac: string;
  title: string;
}

export class PubChemUnavailable extends Error {}

export interface PubChemOptions {
  fetch?: typeof fetch;
  /** Directory for the response cache; null disables caching. */
  cacheDir?: string | null;
  minIntervalMs?: number;
  timeoutMs?: number;
}

interface CachedResponse { status: number; body: string }

const PROPERTIES = 'MolecularFormula,MolecularWeight,SMILES,ConnectivitySMILES,IUPACName,Title';

export class PubChem {
  private readonly fetchImpl: typeof fetch;
  private readonly cacheDir: string | null;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private lastStart = 0;
  private readonly inflight = new Map<string, Promise<CachedResponse>>();

  constructor(options: PubChemOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.cacheDir = options.cacheDir ?? null;
    this.minIntervalMs = options.minIntervalMs ?? 210;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private cachePath(url: string): string | null {
    return this.cacheDir ? path.join(this.cacheDir, createHash('sha1').update(url).digest('hex') + '.json') : null;
  }

  private async readCache(url: string): Promise<CachedResponse | null> {
    const file = this.cachePath(url);
    if (!file) return null;
    try { return JSON.parse(await readFile(file, 'utf8')) as CachedResponse; } catch { return null; }
  }

  private async writeCache(url: string, value: CachedResponse): Promise<void> {
    const file = this.cachePath(url);
    if (!file) return;
    try { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); } catch { /* a cache failure never fails a lookup */ }
  }

  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastStart + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastStart = Date.now();
      return fn();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Rate limited, cached GET. Resolves for 200 and 404; throws PubChemUnavailable otherwise. */
  private get(url: string, accept = 'application/json'): Promise<CachedResponse> {
    const existing = this.inflight.get(url);
    if (existing) return existing;
    const job = (async () => {
      const cached = await this.readCache(url);
      if (cached) return cached;
      const result = await this.throttled(async () => {
        let res: Response;
        try {
          res = await this.fetchImpl(url, { headers: { accept, 'user-agent': 'chem-tool/0.1 (local educational app)' }, signal: AbortSignal.timeout(this.timeoutMs) });
        } catch (err) {
          throw new PubChemUnavailable(`PubChem request failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const body = await res.text();
        if (res.status !== 200 && res.status !== 404) throw new PubChemUnavailable(`PubChem answered ${res.status} for ${url}`);
        return { status: res.status, body };
      });
      await this.writeCache(url, result);
      return result;
    })();
    this.inflight.set(url, job);
    job.finally(() => this.inflight.delete(url)).catch(() => {});
    return job;
  }

  private static parseProperties(body: string): PubChemCompound[] {
    const json = JSON.parse(body) as { PropertyTable?: { Properties?: Array<Record<string, string | number>> } };
    return (json.PropertyTable?.Properties ?? []).map((p) => ({
      cid: Number(p.CID),
      formula: String(p.MolecularFormula ?? ''),
      weight: Number(p.MolecularWeight ?? 0),
      smiles: String(p.SMILES ?? p.ConnectivitySMILES ?? ''),
      connectivitySmiles: String(p.ConnectivitySMILES ?? p.SMILES ?? ''),
      iupac: String(p.IUPACName ?? ''),
      title: String(p.Title ?? ''),
    }));
  }

  async byName(name: string): Promise<PubChemCompound[]> {
    const res = await this.get(`${BASE}/compound/name/${encodeURIComponent(name.trim())}/property/${PROPERTIES}/JSON`);
    return res.status === 200 ? PubChem.parseProperties(res.body) : [];
  }

  async byCids(cids: number[]): Promise<PubChemCompound[]> {
    if (cids.length === 0) return [];
    const res = await this.get(`${BASE}/compound/cid/${cids.join(',')}/property/${PROPERTIES}/JSON`);
    return res.status === 200 ? PubChem.parseProperties(res.body) : [];
  }

  async byCid(cid: number): Promise<PubChemCompound | null> {
    return (await this.byCids([cid]))[0] ?? null;
  }

  /** Compounds with exactly this Hill formula (no charge suffix), PubChem's relevance order. */
  async byFormula(formula: string, max = 8): Promise<PubChemCompound[]> {
    const res = await this.get(`${BASE}/compound/fastformula/${encodeURIComponent(formula)}/cids/JSON?MaxRecords=${max}`);
    if (res.status !== 200) return [];
    const json = JSON.parse(res.body) as { IdentifierList?: { CID?: number[] } };
    return this.byCids((json.IdentifierList?.CID ?? []).slice(0, max));
  }

  /** SDF text, or null when PubChem has no record of that kind (3D is missing for salts and large molecules). */
  async sdf(cid: number, kind: '2d' | '3d'): Promise<string | null> {
    const res = await this.get(`${BASE}/compound/cid/${cid}/SDF?record_type=${kind}`, 'chemical/x-mdl-sdfile');
    return res.status === 200 ? res.body : null;
  }

  async synonyms(cid: number, max = 30): Promise<string[]> {
    const res = await this.get(`${BASE}/compound/cid/${cid}/synonyms/JSON`);
    if (res.status !== 200) return [];
    const json = JSON.parse(res.body) as { InformationList?: { Information?: Array<{ Synonym?: string[] }> } };
    return (json.InformationList?.Information?.[0]?.Synonym ?? []).slice(0, max);
  }

  async description(cid: number): Promise<string | null> {
    const res = await this.get(`${BASE}/compound/cid/${cid}/description/JSON`);
    if (res.status !== 200) return null;
    const json = JSON.parse(res.body) as { InformationList?: { Information?: Array<{ Description?: string }> } };
    return json.InformationList?.Information?.find((i) => i.Description)?.Description ?? null;
  }
}

export function findCas(synonyms: string[]): string | undefined {
  return synonyms.find((s) => /^\d{2,7}-\d{2}-\d$/.test(s));
}
