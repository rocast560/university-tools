import { useState } from 'react';
import type { Species } from '../../chem/types';

export function Structure2D({ species, large = false }: { species: Species; large?: boolean }) {
  const [numbered, setNumbered] = useState(false);
  return (
    <div className={large ? 'structure2d large' : 'structure2d'}>
      <div className="svg-host" dangerouslySetInnerHTML={{ __html: numbered ? species.svg2dNumbered : species.svg2d }} />
      <div className="row">
        <label><input type="checkbox" checked={numbered} onChange={(e) => setNumbered(e.target.checked)} /> atom numbers</label>
        <a href={`/api/species/${species.id}.png?w=1200${numbered ? '&numbered=1' : ''}`} download={`${species.name}.png`}>PNG</a>
        <a href={`/api/species/${species.id}.sdf`} download={`${species.name}.sdf`}>SDF</a>
      </div>
    </div>
  );
}
