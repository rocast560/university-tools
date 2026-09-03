import { useEffect, useRef, useState } from 'react';
import { searchLibrary, type SearchHit } from '../api';
import { load } from '../commands';

export function SearchBar() {
  const [value, setValue] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { searchLibrary(value).then(setHits).catch(() => setHits([])); }, 150);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [value]);

  const submit = async (q: string) => {
    if (!q.trim()) return;
    setBusy(true); setOpen(false);
    try { await load(q); setValue(''); } catch { /* toast shown by commands.ts */ } finally { setBusy(false); }
  };

  return (
    <div className="search">
      <input
        value={value}
        placeholder="Name, formula, SMILES or CAS…  (e.g. caffeine, NaCl, CC(=O)O)"
        onChange={(e) => { setValue(e.target.value); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(value); if (e.key === 'Escape') setOpen(false); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        disabled={busy}
      />
      {busy && <span className="spinner" aria-label="loading" />}
      {open && hits.length > 0 && (
        <ul className="suggestions">
          {hits.map((h) => (
            <li key={h.name} onMouseDown={() => submit(h.name)}>
              <span>{h.name}</span><span className="muted">{h.formula}</span><span className="muted small">{h.category}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
