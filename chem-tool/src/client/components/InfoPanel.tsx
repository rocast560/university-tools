import type { Scene, Species } from '../../chem/types';
import { load } from '../commands';
import { useStore } from '../store';

export function InfoPanel({ species, scene }: { species: Species; scene: Scene }) {
  const alternatives = useStore((s) => s.alternatives);
  return (
    <div className="info">
      <h2>{species.name}</h2>
      {species.iupacName && <div className="muted">{species.iupacName}</div>}
      <table>
        <tbody>
          <tr><th>Formula</th><td>{species.displayFormula}{species.displayFormula !== species.formula && <span className="muted"> (Hill: {species.formula})</span>}</td></tr>
          <tr><th>Molar mass</th><td>{species.info.molarMass} g/mol</td></tr>
          <tr><th>Charge</th><td>{species.charge}</td></tr>
          <tr><th>Atoms</th><td>{species.atoms.length} ({species.atoms.filter((a) => a.element !== 'H').length} heavy)</td></tr>
          <tr><th>Source</th><td>{species.source}{species.cid && <> · <a href={`https://pubchem.ncbi.nlm.nih.gov/compound/${species.cid}`} target="_blank" rel="noreferrer">PubChem {species.cid}</a></>}</td></tr>
          {species.category && <tr><th>Category</th><td>{species.category}</td></tr>}
          {species.geometry !== 'conformer' && <tr><th>3D</th><td>{species.geometry === 'star' ? 'ideal geometry' : 'flat layout (no 3D available)'}</td></tr>}
        </tbody>
      </table>
      {species.description && <p>{species.description}</p>}
      <h3>Composition</h3>
      <table>
        <thead><tr><th>Element</th><th>Count</th><th>Mass %</th></tr></thead>
        <tbody>{species.info.composition.map((c) => <tr key={c.element}><td>{c.element}</td><td>{c.count}</td><td>{c.massPercent.toFixed(2)}</td></tr>)}</tbody>
      </table>
      {alternatives.length > 0 && scene.kind === 'molecule' && (
        <>
          <h3>Same formula</h3>
          <ul className="alternatives">{alternatives.map((a) => <li key={a.name}><button className="link" onClick={() => load(a.name)}>{a.name}</button> <span className="muted">{a.formula}</span></li>)}</ul>
        </>
      )}
    </div>
  );
}
