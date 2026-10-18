"""Measures the weight of every cut against the family the app ships today.

Run from the project root, after build-family.py:
  .cio/tmp/typeface/venv/bin/python docs/designs/brand-typeface/tools/measure-weight.py

The question this answers is the one a reader asks when a face lands in an existing app:
does the weight change? A cut derived from JetBrains Mono keeps that face's strokes exactly,
because the build instances the source rather than redrawing it, and the only ink a cut adds
is what its own decision costs. This prints the ink of the same sample set at every weight,
so the cost is a number rather than an opinion.

Ink is the filled area of the glyphs in square units of the em, summed over a fixed sample,
measured on the default instance of each weight and normalised per glyph. A rounded corner
turned out to its mitre adds a little area at the corner and gives some back to the counter,
so a box cut can come out a hair lighter overall at the same stroke; the strokes themselves
are the same outlines, which verify-family.py asserts point for point.
"""

from __future__ import annotations

import sys
from pathlib import Path

from fontTools.pens.areaPen import AreaPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

PROJECT = Path(__file__).resolve().parents[4]
OUT = PROJECT / ".cio" / "tmp" / "typeface" / "out"
SRC = PROJECT / ".cio" / "tmp" / "typeface" / "source" / "jbm" / "fonts" / "variable" / "JetBrainsMono[wght].ttf"
FONTS = PROJECT / "docs" / "designs" / "brand-typeface" / "fonts"

WEIGHTS = (200, 300, 400, 600, 700, 800)
SAMPLE = "Hamburgefonstiv 0123456789 (){}[] .,:;!? iIl1| rn m 5S 2Z 8B"


def ink(font: TTFont, weight: int) -> float:
    inst = instantiateVariableFont(font, {"wght": weight}, inplace=False)
    glyph_set = inst.getGlyphSet()
    cmap = inst.getBestCmap()
    total = 0.0
    seen = set()
    for ch in SAMPLE:
        name = cmap.get(ord(ch))
        if not name or name in seen:
            continue
        seen.add(name)
        pen = AreaPen(glyph_set)
        glyph_set[name].draw(pen)
        total += abs(pen.value)
    return total / len(seen)


def main() -> int:
    families = {
        "JetBrains Mono": TTFont(SRC),
        "Oven Mono": TTFont(FONTS / "oven-mono-variable.ttf"),
        "Oven Box": TTFont(FONTS / "oven-box-variable.ttf"),
    }
    print(f"ink per glyph over {len(set(SAMPLE))} sample characters, in em units of 1000\n")
    print(f"{'weight':>7}  " + "  ".join(f"{name:>15}" for name in families) + "   box vs JetBrains")
    for w in WEIGHTS:
        row = {name: ink(font, w) for name, font in families.items()}
        known = [name for name, font in families.items() if w <= font["fvar"].axes[0].maxValue and w >= font["fvar"].axes[0].minValue]
        cells = []
        for name in families:
            if name in known:
                cells.append(f"{row[name]:>15.0f}")
            else:
                cells.append(f"{'- not carried -':>15}")
        delta = ""
        if "Oven Box" in known and "JetBrains Mono" in known:
            delta = f"{(row['Oven Box'] / row['JetBrains Mono'] - 1) * 100:+.1f}%"
        print(f"{w:>7}  " + "  ".join(cells) + f"   {delta}")
    print()
    print("Oven Mono carries 300 to 800: its light end is raised on purpose, because weight 200")
    print("is a hairline on a dark plate. Oven Box carries 200 to 800: a squared corner spends")
    print("more ink than a round one, so it can afford JetBrains Mono's own light end.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
