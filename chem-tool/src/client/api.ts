export interface SearchHit { name: string; formula: string; category: string; smiles: string }

export async function searchLibrary(q: string, limit = 8): Promise<SearchHit[]> {
  if (!q.trim()) return [];
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  return res.ok ? res.json() : [];
}
