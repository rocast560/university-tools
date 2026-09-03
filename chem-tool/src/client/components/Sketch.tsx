import { useEffect, useRef } from 'react';
import type { Species } from '../../chem/types';
import { setStructure } from '../commands';
import { shouldResetEditor } from '../sketchSync';
import { useStore } from '../store';
import { windowId } from '../ws';

type OCL = typeof import('openchemlib');
type Editor = InstanceType<OCL['CanvasEditor']>;
type Molecule = InstanceType<OCL['Molecule']>;

/** Canonical ID code without explicit hydrogens, so drawings and server molecules compare equal. */
function idCodeOf(mol: Molecule): string {
  const c = mol.getCompactCopy();
  let heavy = 0;
  for (let i = 0; i < c.getAllAtoms(); i++) if (c.getAtomicNo(i) !== 1) heavy++;
  if (heavy > 0) c.removeExplicitHydrogens();
  return c.getIDCode();
}

export function Sketch({ species }: { species: Species }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const ocl = useRef<OCL | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPushed = useRef<string | null>(null);
  const lastActor = useStore((s) => s.lastActor);
  const version = useStore((s) => s.workspace?.version ?? 0);
  const versionRef = useRef(version);
  versionRef.current = version;
  const speciesRef = useRef(species);
  speciesRef.current = species;

  useEffect(() => {
    let alive = true;
    import('openchemlib').then((m) => {
      if (!alive || !host.current) return;
      ocl.current = m;
      const ed = new m.CanvasEditor(host.current, { initialMode: 'molecule' });
      editor.current = ed;
      ed.setMolecule(m.Molecule.fromMolfile(speciesRef.current.molfile2d));
      ed.setOnChangeListener((ev) => {
        if (!ev.isUserEvent) return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          const mol = ed.getMolecule();
          if (mol.getAllAtoms() === 0) return;
          const id = idCodeOf(mol);
          if (id === lastPushed.current || id === idCodeOf(m.Molecule.fromMolfile(speciesRef.current.molfile2d))) return;
          lastPushed.current = id;
          setStructure(mol.toMolfile(), versionRef.current).catch((err: Error) => {
            useStore.getState().showToast(`${err.message}. Your last stroke was discarded.`);
            ed.setMolecule(m.Molecule.fromMolfile(speciesRef.current.molfile2d));
          });
        }, 300);
      });
    });
    return () => { alive = false; if (timer.current) clearTimeout(timer.current); editor.current?.destroy(); editor.current = null; };
  }, []);

  useEffect(() => {
    const ed = editor.current;
    const m = ocl.current;
    if (!ed || !m) return;
    const incoming = m.Molecule.fromMolfile(species.molfile2d);
    if (shouldResetEditor(lastActor, windowId, idCodeOf(ed.getMolecule()), idCodeOf(incoming))) ed.setMolecule(incoming);
  }, [species.id, lastActor]);

  return (
    <div className="sketch">
      <div ref={host} className="sketch-host" />
      <p className="muted small">Draw or change the molecule. Changes reach the server after 300 ms and every connected AI sees them.</p>
    </div>
  );
}
