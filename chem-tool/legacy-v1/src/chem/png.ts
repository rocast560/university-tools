// SVG to PNG through resvg (native, prebuilt). Used by the image endpoints
// and by the MCP render tools, whose clients display PNG but not SVG.

import { Resvg } from '@resvg/resvg-js';

export function svgToPng(svg: string, width?: number): Uint8Array<ArrayBuffer> {
  const resvg = new Resvg(svg, {
    fitTo: width ? { mode: 'width', value: width } : { mode: 'original' },
    font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
  });
  // Copy into a plain ArrayBuffer backed view so it is a valid Response body.
  return new Uint8Array(resvg.render().asPng());
}

/**
 * The 2D depiction uses currentColor for bonds so it can follow a page
 * theme; a standalone image needs a real colour. Also gives the image a
 * solid background so labels stay readable in any chat client.
 */
export function bakeSvgTheme(svg: string, theme: 'light' | 'dark'): string {
  const fg = theme === 'dark' ? '#e8e8e8' : '#1a1a1a';
  const bg = theme === 'dark' ? '#16181d' : '#ffffff';
  const withColour = svg.replace(/currentColor/g, fg);
  return withColour.replace(/(<svg[^>]*>)/, `$1<rect x="0" y="0" width="100%" height="100%" fill="${bg}"/>`).replace(
    /(<svg[^>]*viewBox="([-\d. ]+)"[^>]*>)<rect[^>]*\/>/,
    (_m, open: string, vb: string) => {
      const [x, y, w, h] = vb.split(/\s+/).map(Number);
      return `${open}<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${bg}"/>`;
    },
  );
}
