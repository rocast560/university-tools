import { describe, expect, test } from 'bun:test';
import { platformDefaults } from '../server/config.ts';

describe('platformDefaults', () => {
  test('windows: KiCad under LOCALAPPDATA, table under APPDATA, Consolas', () => {
    const d = platformDefaults('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me');
    expect(d.kicadCli).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\KiCad\\9.0\\bin\\kicad-cli.exe');
    expect(d.kicadSymbolDir).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\KiCad\\9.0\\share\\kicad\\symbols');
    expect(d.symLibTable).toBe('C:\\Users\\me\\AppData\\Roaming\\kicad\\9.0\\sym-lib-table');
    expect(d.dataDir).toBe('C:\\Users\\me\\AppData\\Local\\UniversityTools\\circuit');
    expect(d.projectsDir).toBe('C:\\Users\\me\\Documents\\KiCad\\9.0\\projects');
    expect(d.pngFont).toBe('Consolas');
  });

  test('windows without LOCALAPPDATA and APPDATA derives them from home', () => {
    const d = platformDefaults('win32', {}, 'C:\\Users\\me');
    expect(d.kicadCli).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\KiCad\\9.0\\bin\\kicad-cli.exe');
    expect(d.symLibTable).toBe('C:\\Users\\me\\AppData\\Roaming\\kicad\\9.0\\sym-lib-table');
  });

  test('linux: kicad-cli on PATH, /usr/share/kicad, XDG folders, DejaVu Sans Mono', () => {
    const d = platformDefaults('linux', {}, '/home/kicad');
    expect(d.kicadCli).toBe('kicad-cli');
    expect(d.kicadSymbolDir).toBe('/usr/share/kicad/symbols');
    expect(d.symLibTable).toBe('/home/kicad/.config/kicad/9.0/sym-lib-table');
    expect(d.dataDir).toBe('/home/kicad/.local/share/university-tools/circuit');
    expect(d.projectsDir).toBe('/home/kicad/KiCad/9.0/projects');
    expect(d.pngFont).toBe('DejaVu Sans Mono');
  });

  test('linux honours XDG_CONFIG_HOME and XDG_DATA_HOME', () => {
    const d = platformDefaults('linux', { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/dat' }, '/home/kicad');
    expect(d.symLibTable).toBe('/cfg/kicad/9.0/sym-lib-table');
    expect(d.dataDir).toBe('/dat/university-tools/circuit');
  });
});
