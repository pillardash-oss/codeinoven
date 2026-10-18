"""Extract menu bar outlines from the app's bundled Oven Box, at weight 600.

Run with the font build environment:
  .cio/tmp/typeface/venv/bin/python scripts/extract-tray-count-digits.py
Then regenerate strips with scripts/build-mac-tray-count-strip.ts.
Only fontTools and brotli (already used by the font builder) are required.
"""
from pathlib import Path
import hashlib
import json
import subprocess
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'resources/fonts/oven/oven-box.woff2'
font = instantiateVariableFont(TTFont(SOURCE), {'wght': 600}, inplace=True)
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
characters = '0123456789+'
bounds = {}
for char in characters:
    pen = BoundsPen(glyphs)
    glyphs[cmap[ord(char)]].draw(pen)
    bounds[char] = pen.bounds
# Use one scale for all figures, preserving Oven Box's relative stroke weights.
scale = min(25 / max(b[2] - b[0] for b in bounds.values()),
            40 / max(b[3] - b[1] for b in bounds.values()))
paths = {}
for char in characters:
    x0, y0, x1, y1 = bounds[char]
    pen = SVGPathPen(glyphs, ntos=lambda n: format(n, '.4f').rstrip('0').rstrip('.') or '0')
    # Digits share a cap centre; the plus keeps its own centre on the same line.
    centre_y = (y0 + y1) / 2 if char == '+' else 365
    transform = (scale, 0, 0, -scale, 12.5 - scale * (x0 + x1) / 2,
                 20 + scale * centre_y)
    glyphs[cmap[ord(char)]].draw(TransformPen(pen, transform))
    paths[char] = [pen.getCommands()]
header = f'''/**
 * Generated from resources/fonts/oven/oven-box.woff2 at weight 600.
 * Source SHA-256: {hashlib.sha256(SOURCE.read_bytes()).hexdigest()}
 * Regenerate with scripts/extract-tray-count-digits.py. Outlines are filled,
 * uniformly scaled to the existing 25 × 40 artwork box, never re-stroked.
 * Font outlines retain the SIL OFL license in resources/fonts/oven/OFL.txt.
 */
'''
body = f'export const TRAY_COUNT_FONT_SHA256 = "{hashlib.sha256(SOURCE.read_bytes()).hexdigest()}"\n\n'
body += 'export const TRAY_COUNT_NUMERALS: Readonly<Record<string, readonly string[]>> = '
body += json.dumps(paths, indent=2) + '\n\n'
body += '''/** Filled Oven Box outlines for one count character. */
export function trayNumeralPaths(character: string): readonly string[] {
  const paths = TRAY_COUNT_NUMERALS[character]
  if (!paths) throw new Error(`No Oven Box menu bar numeral for "${character}"`)
  return paths
}
'''
(ROOT / 'scripts/tray-count-digits.ts').write_text(header + body)
subprocess.run(['bun', 'run', 'format', 'scripts/tray-count-digits.ts'], cwd=ROOT, check=True)
print(f'Extracted {len(paths)} Oven Box glyphs at uniform scale {scale:.6f}')
