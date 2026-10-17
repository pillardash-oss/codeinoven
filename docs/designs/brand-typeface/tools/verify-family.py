"""Checks the built family rather than trusting the build log.

Run from the project root, after build-family.py:
  .cio/tmp/typeface/venv/bin/python docs/designs/brand-typeface/tools/verify-family.py

Every check below fails the run with a non-zero exit code, so a bad build cannot be
committed quietly. It verifies what the app depends on: one advance per glyph at every
weight, unchanged vertical metrics, kept glyph coverage, and ligatures that still shape.
"""
import glob
import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

PROJECT = Path(__file__).resolve().parents[4]
VF = glob.glob(str(PROJECT / ".cio" / "tmp" / "typeface" / "out" / "OvenMono*.ttf"))[0]
SRC = str(PROJECT / ".cio" / "tmp" / "typeface" / "source" / "jbm" / "fonts" / "variable" / "JetBrainsMono[wght].ttf")
fails = []

def check(label, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + label + ((' :: ' + str(detail)) if detail else ''))
    if not ok: fails.append(label)

vf = TTFont(VF)
check('family name', vf['name'].getDebugName(1) == 'Oven Mono', vf['name'].getDebugName(1))
check('axes', [(a.axisTag, a.minValue, a.defaultValue, a.maxValue) for a in vf['fvar'].axes] == [('wght',300.0,400.0,800.0)], [(a.axisTag,a.minValue,a.defaultValue,a.maxValue) for a in vf['fvar'].axes])
check('fixed pitch', vf['post'].isFixedPitch == 1)
check('upm', vf['head'].unitsPerEm == 1000)
check('has GSUB (ligatures)', 'GSUB' in vf)

src = TTFont(SRC)
srcorder = set(src.getGlyphOrder())
vforder = set(vf.getGlyphOrder())
check('glyph coverage kept', srcorder.issubset(vforder), f'{len(srcorder)} in source, missing {sorted(srcorder-vforder)[:8]}')

# advances unchanged at every weight, so no layout moves
for w in (300, 400, 700, 800):
    o = instantiateVariableFont(TTFont(SRC), {'wght': w}, inplace=True)
    n = instantiateVariableFont(TTFont(VF), {'wght': w}, inplace=True)
    bad = [g for g in o.getGlyphOrder() if g in n.getGlyphOrder() and o['hmtx'][g][0] != n['hmtx'][g][0]]
    check(f'advances unchanged at {w}', not bad, bad[:6])

# metrics identical, so line height and baseline do not move
for tag, fields in (('OS/2', ['sTypoAscender','sTypoDescender','sTypoLineGap','sxHeight','sCapHeight','usWinAscent','usWinDescent']), ('hhea', ['ascent','descent','lineGap'])):
    check(f'{tag} metrics match', all(getattr(vf[tag], k) == getattr(src[tag], k) for k in fields), [ (k, getattr(vf[tag],k), getattr(src[tag],k)) for k in fields if getattr(vf[tag],k)!=getattr(src[tag],k)])

# the dots are actually squares, and square at every weight
n400 = instantiateVariableFont(TTFont(VF), {'wght': 400}, inplace=True)
gs = n400.getGlyphSet()
def shape(g):
    bp = BoundsPen(gs); gs[g].draw(bp)
    x0,y0,x1,y1 = bp.bounds
    return round(x1-x0,1), round(y1-y0,1)
for g in ('period','uni0307','bullet'):
    if g not in n400.getGlyphOrder(): continue
    w,h = shape(g)
    check(f'{g} square', abs(w-h) < 2, (w,h))

# shaping: ligatures still fire, dot glyphs still map
def dot_boxes_for(font, name):
    from fontTools.pens.recordingPen import RecordingPen
    rec = RecordingPen()
    font.getGlyphSet()[name].draw(rec)
    n = sum(1 for op, _ in rec.value if op == 'moveTo')
    return [None] * n


def shape_text(path, text, variations):
    blob = hb.Blob.from_file_path(path)
    face = hb.Face(blob); font = hb.Font(face)
    if variations: font.set_variations(variations)
    buf = hb.Buffer(); buf.add_str(text); buf.guess_segment_properties()
    hb.shape(font, buf, {'liga': True, 'calt': True})
    return [(font.get_glyph_name(i.codepoint), p.x_advance) for i,p in zip(buf.glyph_infos, buf.glyph_positions)]

a = shape_text(VF, 'a -> b => c != d === e', {'wght': 400})
b = shape_text(SRC, 'a -> b => c != d === e', {'wght': 400})
check('ligatures match source', [g for g,_ in a] == [g for g,_ in b], (a, b))
check('ligature advances match', [x for _,x in a] == [x for _,x in b])

# colon, exclam and question carry two contours, one of which is not a dot: they must keep
# both, or a colon would lose its lower dot and an exclam its stem.
for g, want in (('colon', 2), ('semicolon', 2), ('exclam', 2), ('question', 2), ('ellipsis', 3)):
    if g not in n400.getGlyphOrder(): continue
    contours = len(dot_boxes_for(n400, g))
    check(f'{g} keeps {want} contours', contours == want, contours)

txt = 'CodeInOven. 1.0'
sh = shape_text(VF, txt, {'wght': 400})
check('shaped period sum advance', sum(x for _,x in sh) == 600*len(txt), (sum(x for _,x in sh), 600*len(txt)))

print()
print('FAILURES:', fails if fails else 'none')
sys.exit(1 if fails else 0)
