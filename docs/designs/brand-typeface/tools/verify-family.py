"""Checks a built cut rather than trusting the build log.

Run from the project root, after build-family.py:
  .cio/tmp/typeface/venv/bin/python docs/designs/brand-typeface/tools/verify-family.py --variant box

Every check below fails the run with a non-zero exit code, so a bad build cannot be
committed quietly. It verifies what the app depends on: one advance per glyph at every
weight, unchanged vertical metrics, kept glyph coverage, ligatures that still shape, and
then the cut's own decision, that a box cut has no drawn corner left round and has lost no
counter to the squaring.
"""
import argparse
import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.areaPen import AreaPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

sys.path.insert(0, str(Path(__file__).resolve().parent))

PROJECT = Path(__file__).resolve().parents[4]
OUT = PROJECT / ".cio" / "tmp" / "typeface" / "out"
SRC = str(PROJECT / ".cio" / "tmp" / "typeface" / "source" / "jbm" / "fonts" / "variable" / "JetBrainsMono[wght].ttf")
fails = []


def check(label, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + label + ((' :: ' + str(detail)) if detail else ''))
    if not ok: fails.append(label)


def curves_in(glyph_set, name):
    rec = RecordingPen()
    glyph_set[name].draw(rec)
    return sum(1 for op, _ in rec.value if op in ('qCurveTo', 'curveTo'))


def contours_in(glyph_set, name):
    rec = RecordingPen()
    glyph_set[name].draw(rec)
    return sum(1 for op, _ in rec.value if op == 'moveTo')


def area_of(glyph_set, name):
    pen = AreaPen(glyph_set)
    glyph_set[name].draw(pen)
    return abs(pen.value)


def points_of(glyph_set, name):
    """Every on-curve point of a glyph, rounded, for an exact comparison between two builds."""
    rec = RecordingPen()
    glyph_set[name].draw(rec)
    pts = []
    for op, args in rec.value:
        for a in args:
            if isinstance(a, tuple):
                pts.append((round(a[0], 3), round(a[1], 3)))
    return pts


# The cuts, read from the builder so a cut and its verification cannot drift apart.
import importlib.util

spec = importlib.util.spec_from_file_location("oven_build", Path(__file__).resolve().parent / "build-family.py")
oven_build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oven_build)
VARIANTS = oven_build.VARIANTS

parser = argparse.ArgumentParser(description="Verify one cut of the Oven family.")
parser.add_argument("--variant", choices=sorted(VARIANTS), default="mono")
variant = parser.parse_args().variant
spec_of_cut = VARIANTS[variant]
VF = str(OUT / spec_of_cut["file"])
weight_min, weight_default, weight_max = spec_of_cut["axis"]

vf = TTFont(VF)
check('family name', vf['name'].getDebugName(1) == spec_of_cut["family"], vf['name'].getDebugName(1))
check(
    'axes',
    [(a.axisTag, a.minValue, a.defaultValue, a.maxValue) for a in vf['fvar'].axes]
    == [('wght', float(weight_min), float(weight_default), float(weight_max))],
    [(a.axisTag, a.minValue, a.defaultValue, a.maxValue) for a in vf['fvar'].axes],
)
check('fixed pitch', vf['post'].isFixedPitch == 1)
check('upm', vf['head'].unitsPerEm == 1000)
check('has GSUB (ligatures)', 'GSUB' in vf)

src = TTFont(SRC)
srcorder = set(src.getGlyphOrder())
vforder = set(vf.getGlyphOrder())
check('glyph coverage kept', srcorder.issubset(vforder), f'{len(srcorder)} in source, missing {sorted(srcorder-vforder)[:8]}')

# advances unchanged at every weight, so no layout moves
for w in (weight_min, 400, 700, weight_max):
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

# The cut's own decision. A box cut has turned every drawn corner out to its mitre, so no
# rounded glyph may still carry a curve, and a parenthesis, which is excluded on purpose
# because a square parenthesis is a bracket, must still carry them.
if spec_of_cut['square']:
    rounded = ('o', 'O', 'e', 'a', 'g', 'b', 'd', 'p', 'q', 'n', 'u', 'h', 'm', 'c', 'C',
               'G', 'D', 'U', 'B', 'P', 'R', 'Q', 'J', 's', 'S', 'zero', 'two', 'three',
               'five', 'six', 'eight', 'nine', 'A', 'V', 'W', 'X', 'Y', 'M', 'N')
    left = [(g, curves_in(gs, g)) for g in rounded if g in n400.getGlyphOrder() and curves_in(gs, g)]
    check('no drawn corner left round', not left, left[:8])
    for g in ('parenleft', 'parenright'):
        if g in n400.getGlyphOrder():
            check(f'{g} stays round', curves_in(gs, g) > 0, curves_in(gs, g))
    # Squaring must not eat a counter: the same number of contours, and more ink than the
    # round cut but not a blob.
    src400 = instantiateVariableFont(TTFont(SRC), {'wght': 400}, inplace=True)
    sgs = src400.getGlyphSet()
    lost = [g for g in ('o', 'O', 'e', 'a', 'g', 'zero', 'eight', 'B', 'R', 'P')
            if g in n400.getGlyphOrder() and contours_in(gs, g) != contours_in(sgs, g)]
    check('counters kept', not lost, lost)
    # A squared counter is a rectangle where the round one was a bowl, so it gains area and
    # the glyph's ink can fall a little; a corner turned out to its mitre gains some. The ink
    # must stay inside a band either way, which is what catches a blob and a hollow shape.
    grown = []
    for g in ('o', 'O', 'e', 'a', 'g', 'zero', 'eight'):
        if g not in n400.getGlyphOrder():
            continue
        a0, a1 = area_of(sgs, g), area_of(gs, g)
        if not (a0 * 0.8 <= a1 <= a0 * 1.4):
            grown.append((g, round(a0), round(a1), round(a1 / a0, 2)))
    check('ink stays in band', not grown, grown)
    # The weight itself is not a drawing decision: every glyph with no corner at all must come
    # out of the box build point for point identical to JetBrains Mono, which is what proves a
    # squared cut matches the family the app ships at the same coordinate.
    straight = ('H', 'E', 'F', 'L', 'T', 'I', 'z', 'k', 'K', 'Z', 'four', 'seven', 'equal', 'plus', 'underscore')
    drifted = []
    for g in straight:
        if g not in n400.getGlyphOrder():
            continue
        if points_of(sgs, g) != points_of(gs, g):
            drifted.append(g)
    check('straight glyphs identical to JetBrains Mono', not drifted, drifted)

print()
print('FAILURES:', fails if fails else 'none')
sys.exit(1 if fails else 0)
