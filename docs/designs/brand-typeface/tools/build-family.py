"""
Build Oven Mono and its cuts: real variable fonts for CodeInOven, derived from JetBrains
Mono (SIL OFL 1.1) and finished with the brand mark's construction.

Prerequisites, none of which are project dependencies:
  python3 -m venv .cio/tmp/typeface/venv
  .cio/tmp/typeface/venv/bin/pip install fonttools brotli uharfbuzz
  download JetBrainsMono-2.304.zip from the JetBrains Mono releases page and unpack it so
  that .cio/tmp/typeface/source/jbm/fonts/variable/JetBrainsMono[wght].ttf exists.

The brief: keep JetBrains Mono's comfort, because that is the skeleton people already
read all day, and change only what carries the brand. What carries the brand is the
dot. The mark is a squared vessel with a gold knob: square corners, one circle for the
knob, and a bar cut flat. JetBrains Mono's dots are circles, so the whole dot system
becomes a square cut, and every other letterform stays exactly as comfortable as it is.

Two cuts come out of that brief, and they are the same family drawn twice:

  mono  Oven Mono. The base cut. Dots squared, the ASCII quote marks cut flat, and every
        letterform otherwise exactly JetBrains Mono's, so a page set in it is a page a
        reader has read all day. Masters 300 to 800: the light end is raised on purpose,
        because weight 200 is a hairline on a dark plate and the squared dots read better
        with a little more ink under them.
  box   Oven Box. The squared cut. The same dots and the same quotes, and then every
        rounded corner in the alphabet is turned out to its own mitre: a corner drawn as a
        quadratic keeps its control point as the corner, which is where the two tangents of
        that corner already cross. A run of corners that belongs to one bend is merged back
        into the single corner its outer tangents meet at, so a bowl comes out a rectangle
        rather than an octagon. Weights 200 to 800, matching JetBrains Mono at every shared
        coordinate, because a squared corner spends more ink than a round one at the same
        stroke.

Nothing here redraws a letter. The build instances JetBrains Mono at the masters, applies
the cut's own treatment, and assembles a wght axis from those masters, so the family is a
real font a terminal, an editor and a browser can all install.

Run, from the project root:
  .cio/tmp/typeface/venv/bin/python docs/designs/brand-typeface/tools/build-family.py --variant box
  .cio/tmp/typeface/venv/bin/python docs/designs/brand-typeface/tools/verify-family.py --variant box
  .cio/tmp/typeface/venv/bin/python docs/designs/brand-typeface/tools/measure-weight.py

then copy the written files from .cio/tmp/typeface/out into fonts/.
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from fontTools.designspaceLib import AxisDescriptor, DesignSpaceDocument, SourceDescriptor
from fontTools.pens.basePen import BasePen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import build as build_variable
from fontTools.varLib.instancer import instantiateVariableFont

PROJECT = Path(__file__).resolve().parents[4]
SOURCE = PROJECT / ".cio" / "tmp" / "typeface" / "source" / "jbm" / "fonts" / "variable" / "JetBrainsMono[wght].ttf"
OUT = PROJECT / ".cio" / "tmp" / "typeface" / "out"

# The dot is the mark's knob, the bar is the mark's shelf. Every glyph below carries at
# least one dot, and the list beside it says which of its contours are dots, so the
# decision is curated rather than guessed and is identical in every master.
DOT_GLYPHS = {
    "period": [0],
    "colon": [0, 1],
    "semicolon": [0],  # index 1 is the tail of the comma, not a dot
    "exclam": [1],  # index 0 is the stem
    "question": [1],  # index 0 is the bowl and its stem
    "ellipsis": [0, 1, 2],
    "uni0307": [0],
    "uni0308": [0, 1],
}

# The ASCII quote marks are the one other place the face tapers, and the mark never tapers:
# its shelf is a bar cut flat at both ends. These become bars of constant width on the same
# box, so `'` reads as a straight mark beside a curly typographic quote instead of as a
# small triangle. U+2018 and U+2019 keep their curl, because prose needs to tell them apart.
BAR_GLYPHS = ["quotesingle", "quotesinglbase"]

# A zero's inner mark is the same device, so it takes the same cut.
ZERO_DOT = "zero"
ZERO_DOT_CONTOUR = 2

# The mark's own device, squared: a dot is the knob, a quote mark is the shelf.
SQUARE_RATIO = 0.86

# ── The cuts ───────────────────────────────────────────────────────────────
# One family, drawn twice. A cut says which weights it carries and whether the alphabet's
# rounded corners are turned out to their mitres, and nothing else: everything a cut
# shares is inherited from JetBrains Mono, so a third cut is one row here.
VARIANTS = {
    "mono": {
        "family": "Oven Mono",
        "slug": "oven-mono",
        "file": "OvenMono[wght].ttf",
        "masters": [300, 400, 600, 800],
        "axis": (300, 400, 800),
        "square": False,
    },
    "box": {
        "family": "Oven Box",
        "slug": "oven-box",
        "file": "OvenBox[wght].ttf",
        "masters": [200, 300, 400, 600, 800],
        "axis": (200, 400, 800),
        "square": True,
    },
}

VERSION = "1.000"
COPYRIGHT = (
    "Copyright 2026 CodeInOven. Derived from JetBrains Mono, "
    "Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono), "
    "licensed under the SIL Open Font License, Version 1.1."
)
LICENSE_URL = "https://scripts.sil.org/OFL"

# Coverage the app, the editor and the terminal need, kept deliberately wide enough for
# prose, code and shell output rather than a Latin-only cut.
LATIN_EXTRA = list(range(0x00C0, 0x0100)) + list(range(0x0100, 0x0180))


def contour_points(pen_values):
    """Flatten a recorded pen into on-curve polygons, good enough to measure a dot."""
    pts = []
    for op, args in pen_values:
        for a in args:
            if isinstance(a, tuple):
                pts.append(a)
    return pts


def dot_boxes(glyph_set, name: str):
    """The bounding boxes of each separate dot (each contour) in a glyph."""
    rec = RecordingPen()
    glyph_set[name].draw(rec)
    boxes = []
    current = []
    for op, args in rec.value:
        if op == "moveTo":
            if current:
                boxes.append(current)
            current = [args[0]]
        elif op in ("lineTo",):
            current.append(args[0])
        elif op == "qCurveTo":
            current.extend([a for a in args if a is not None])
        elif op == "curveTo":
            current.extend([a for a in args if a is not None])
        elif op == "closePath":
            if current:
                boxes.append(current)
            current = []
    if current:
        boxes.append(current)

    out = []
    for contour in boxes:
        xs = [p[0] for p in contour]
        ys = [p[1] for p in contour]
        out.append((min(xs), min(ys), max(xs), max(ys)))
    return out


def square_contour(cx: float, cy: float, side: float):
    h = side / 2
    return [
        (cx - h, cy - h),
        (cx + h, cy - h),
        (cx + h, cy + h),
        (cx - h, cy + h),
    ]


def dot_side(x0, y0, x1, y1) -> float:
    """The side of the square that replaces one dot.

    A circle of diameter d becomes a square whose side is 0.86 d, which is the same
    optical mass. The ellipsis dots are narrow vertical lozenges rather than circles, so
    they are squared on their mean dimension instead of being shrunk to their width.
    """
    w = x1 - x0
    h = y1 - y0
    ratio = w / h if h else 1
    diameter = min(w, h) if 0.85 <= ratio <= 1.18 else math.sqrt(w * h)
    return diameter * SQUARE_RATIO


def redraw_dots(font: TTFont, weight: int, plan: dict[str, list[int]]) -> dict[str, int]:
    """Replace the planned dot contours with squares, leaving every other contour alone."""
    glyf = font["glyf"]
    order = set(font.getGlyphOrder())
    changed = {}

    for name, dot_indices in plan.items():
        if name not in order or glyf[name].isComposite() or not dot_indices:
            continue
        boxes = dot_boxes(font.getGlyphSet(), name)
        if not boxes:
            continue
        pen = TTGlyphPen(glyf)
        for i, (x0, y0, x1, y1) in enumerate(boxes):
            if i not in dot_indices:
                _replay_contour(pen, font, name, (x0, y0, x1, y1))
                continue
            pts = square_contour((x0 + x1) / 2, (y0 + y1) / 2, dot_side(x0, y0, x1, y1))
            pen.moveTo(pts[0])
            for p in pts[1:]:
                pen.lineTo(p)
            pen.closePath()
        glyf[name] = pen.glyph()
        changed[name] = len(dot_indices)
    return changed


def _replay_contour(pen, font, glyph_name, target_box):
    """Re-draw one contour unchanged, so mixed glyphs keep their tails and stems."""
    rec = RecordingPen()
    font.getGlyphSet()[glyph_name].draw(rec)
    # Rebuild contour by contour, matching the requested box.
    contours = []
    current = []
    for op, args in rec.value:
        if op == "moveTo":
            if current:
                contours.append(current)
            current = [(op, args)]
        elif op in ("lineTo", "qCurveTo", "curveTo"):
            if current:
                current.append((op, args))
        elif op == "closePath":
            if current:
                current.append((op, []))
                contours.append(current)
            current = []
    if current:
        contours.append(current)

    for contour in contours:
        pts = []
        for op, args in contour:
            for a in args:
                if isinstance(a, tuple):
                    pts.append(a)
        if not pts:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        box = (min(xs), min(ys), max(xs), max(ys))
        if all(math.isclose(a, b, abs_tol=1.0) for a, b in zip(box, target_box)):
            for op, args in contour:
                if op == "moveTo":
                    pen.moveTo(args[0])
                elif op == "lineTo":
                    pen.lineTo(args[0])
                elif op == "qCurveTo":
                    pen.qCurveTo(*args)
                elif op == "curveTo":
                    pen.curveTo(*args)
                elif op == "closePath":
                    pen.closePath()
            return


def square_zero_dot(font: TTFont):
    """The zero's inner mark is the same device, so it takes the same cut."""
    glyf = font["glyf"]
    if ZERO_DOT not in font.getGlyphOrder():
        return
    boxes = dot_boxes(font.getGlyphSet(), ZERO_DOT)
    if len(boxes) <= ZERO_DOT_CONTOUR:
        return
    x0, y0, x1, y1 = boxes[ZERO_DOT_CONTOUR]
    pen = TTGlyphPen(glyf)
    for i, (bx0, by0, bx1, by1) in enumerate(boxes):
        if i != ZERO_DOT_CONTOUR:
            _replay_contour(pen, font, ZERO_DOT, (bx0, by0, bx1, by1))
            continue
        pts = square_contour((x0 + x1) / 2, (y0 + y1) / 2, dot_side(x0, y0, x1, y1))
        pen.moveTo(pts[0])
        for p in pts[1:]:
            pen.lineTo(p)
        pen.closePath()
    glyf[ZERO_DOT] = pen.glyph()


def rename(font: TTFont, weight: int, is_variable: bool, family: str):
    name = font["name"]
    style = {200: "ExtraLight", 300: "Light", 400: "Regular", 600: "SemiBold", 800: "ExtraBold"}
    sub = "Variable" if is_variable else style[weight]
    full = f"{family} {sub}" if is_variable else f"{family} {style[weight]}"

    records = {
        0: COPYRIGHT,
        1: family,
        2: "Regular" if is_variable else style[weight],
        3: f"1.000;CIO;{family.replace(' ', '')}-{sub}",
        4: full,
        5: f"Version {VERSION}",
        6: f"{family.replace(' ', '')}-{sub}",
        7: f"{family} is a trademark of CodeInOven.",
        8: "CodeInOven",
        9: "CodeInOven",
        11: "https://codeinoven.dev",
        12: "https://codeinoven.dev",
        13: "This Font Software is licensed under the SIL Open Font License, Version 1.1. "
        "It is derived from JetBrains Mono by The JetBrains Mono Project Authors.",
        14: LICENSE_URL,
        16: family,
        17: sub,
    }
    name.names = []
    for nid, value in records.items():
        name.setName(value, nid, 3, 1, 0x409)
        name.setName(value, nid, 1, 0, 0)

    os2 = font["OS/2"]
    os2.usWeightClass = weight if not is_variable else 400
    os2.fsType = 0
    os2.achVendID = "CIOn"
    os2.panose.bProportion = 9
    os2.panose.bFamilyType = 2
    os2.sxHeight = 550
    os2.sCapHeight = 730
    font["post"].isFixedPitch = 1


def flat_bars(font: TTFont) -> dict[str, int]:
    """Square off the tapered ASCII quote marks into bars of constant width.

    The contour is replaced by the rectangle that shares its own bounding box, so the mark
    keeps its position on the line and its optical width, and only the taper goes.
    """
    glyf = font["glyf"]
    order = set(font.getGlyphOrder())
    changed = {}
    for name in BAR_GLYPHS:
        if name not in order or glyf[name].isComposite():
            continue
        boxes = dot_boxes(font.getGlyphSet(), name)
        if not boxes:
            continue
        pen = TTGlyphPen(glyf)
        for (x0, y0, x1, y1) in boxes:
            pen.moveTo((x0, y0))
            pen.lineTo((x1, y0))
            pen.lineTo((x1, y1))
            pen.lineTo((x0, y1))
            pen.closePath()
        glyf[name] = pen.glyph()
        changed[name] = len(boxes)
    return changed


def plan_dots() -> dict[str, list[int]]:
    """The curated plan, limited to glyphs this build actually has as simple outlines."""
    base = instantiateVariableFont(TTFont(SOURCE), {"wght": 400}, inplace=True)
    order = set(base.getGlyphOrder())
    plan = {}
    for name, indices in DOT_GLYPHS.items():
        if name not in order or base["glyf"][name].isComposite():
            continue
        plan[name] = indices
    return plan


# ── The squared cut ────────────────────────────────────────────────────────
# A rounded corner in a TrueType outline is a quadratic whose control point is where that
# corner's two tangents already cross. Turning the corner out to its own mitre is therefore
# not a redraw: the control point becomes an on-curve point, and the rounded corner becomes
# the corner it was drawn around.
#
# TURN_MIN is the one rule that keeps that honest. A segment that turns less than this was
# never a corner; it is a stroke with a gentle bend in it, and it is straightened to its own
# chord instead, which is what takes the last of the bulge out of a bowl's side.
#
# Promoting corners is not merged back afterwards. A join of two promoted corners already is
# the corner, and collapsing a longer run into the one corner its outer tangents meet at
# reads well on a bowl but swallows the counters of a tight spiral: the capital S, whose
# whole side is one run, came out solid. The cut keeps the corners the alphabet actually has.
TURN_MIN = 38.0

# Keep it a text face. A parenthesis drawn square is a bracket, and a reader scanning a line
# of code needs to tell one from the other, so the pair stays round in every cut.
SQUARE_EXCLUDE = {"parenleft", "parenright", "uni2018", "uni2019", "uni201C", "uni201D"}


def _angle(p, c, n) -> float:
    """How far the path turns at c, between the incoming and the outgoing direction."""
    ax, ay = c[0] - p[0], c[1] - p[1]
    bx, by = n[0] - c[0], n[1] - c[1]
    la, lb = math.hypot(ax, ay), math.hypot(bx, by)
    if not la or not lb:
        return 0.0
    cos = max(-1.0, min(1.0, (ax * bx + ay * by) / (la * lb)))
    return math.degrees(math.acos(cos))


def _cross(a, b, c, d):
    """Where the line a-b meets the line c-d, or None when they are parallel."""
    r = (b[0] - a[0], b[1] - a[1])
    s = (d[0] - c[0], d[1] - c[1])
    den = r[0] * s[1] - r[1] * s[0]
    if abs(den) < 1e-9:
        return None
    t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den
    return (a[0] + t * r[0], a[1] + t * r[1])


class MitrePen(BasePen):
    """Emits the outline with every drawn corner turned out to its mitre.

    Points are tagged as they are emitted, because a corner and a straight run cannot be
    told apart once both are polylines, and the merge pass needs to know which vertices a
    bend contributed.
    """

    def __init__(self, out, variety: int):
        super().__init__(None)
        self.out = out
        self.variety = variety
        self.cur = None
        self.tagged: list[tuple[tuple[float, float], bool]] = []
        self.contours: list[list[tuple[tuple[float, float], bool]]] = []

    def _emit(self, pt, from_curve: bool):
        self.tagged.append((pt, from_curve))
        self.cur = pt

    def _moveTo(self, pt):
        if self.tagged:
            self.contours.append(self.tagged)
        self.tagged = []
        self._emit(pt, False)

    def _lineTo(self, pt):
        self._emit(pt, False)

    def _qCurveToOne(self, pt1, pt2):
        if _angle(self.cur, pt1, pt2) >= TURN_MIN:
            self._emit(pt1, True)
            self._emit(pt2, True)
        else:
            self._emit(pt2, False)

    def _curveToOne(self, p1, p2, p3):
        corner = _cross(self.cur, p1, p2, p3)
        if corner is not None and _angle(self.cur, corner, p3) >= TURN_MIN:
            self._emit(corner, True)
            self._emit(p3, True)
        else:
            self._emit(p3, False)

    def _closePath(self):
        if self.tagged:
            self.contours.append(self.tagged)
        self.tagged = []
        self.cur = None

    def _endPath(self):
        self._closePath()

    def done(self):
        """Every contour the pen walked, with its promoted corners already tagged."""
        if self.tagged:
            self.contours.append(self.tagged)
            self.tagged = []
        walked = self.contours
        self.contours = []
        return walked


def square_outlines(font: TTFont) -> dict[str, int]:
    """Turn every drawn corner of the alphabet out to its mitre."""
    glyf = font["glyf"]
    changed = {}
    for name in font.getGlyphOrder():
        if name in SQUARE_EXCLUDE or glyf[name].isComposite():
            continue
        out = TTGlyphPen(glyf)
        pen = MitrePen(out, 1)
        font.getGlyphSet()[name].draw(pen)
        contours = pen.done()
        if not contours:
            continue
        for contour in contours:
            out.moveTo(contour[0][0])
            for pt, _ in contour[1:]:
                out.lineTo(pt)
            out.closePath()
        glyf[name] = out.glyph()
        changed[name] = sum(len(c) for c in contours)
    return changed


def build(variant: str):
    spec = VARIANTS[variant]
    family = spec["family"]
    masters_at = spec["masters"]
    axis_min, axis_default, axis_max = spec["axis"]
    OUT.mkdir(parents=True, exist_ok=True)
    plan = plan_dots()
    print("dot plan:", plan)
    masters = []
    for w in masters_at:
        f = TTFont(SOURCE)
        inst = instantiateVariableFont(f, {"wght": w}, inplace=True, updateFontNames=False)
        changed = redraw_dots(inst, w, plan)
        square_zero_dot(inst)
        bars = flat_bars(inst)
        cuts = square_outlines(inst) if spec["square"] else {}
        rename(inst, w, is_variable=False, family=family)
        path = OUT / f"master-{w}.ttf"
        inst.save(path)
        masters.append((w, path))
        print(f"master {w}: dots {changed} bars {bars} corners {len(cuts)}")

    ds = DesignSpaceDocument()
    axis = AxisDescriptor()
    axis.name = "Weight"
    axis.tag = "wght"
    axis.minimum = axis_min
    axis.default = axis_default
    axis.maximum = axis_max
    axis.map = [(w, w) for w in masters_at]
    ds.addAxis(axis)

    for w, path in masters:
        src = SourceDescriptor()
        src.path = str(path)
        src.name = f"master-{w}"
        src.location = {"Weight": w}
        if w == axis_default:
            src.copyInfo = True
            src.copyLib = True
            src.copyFeatures = True
        ds.addSource(src)

    from fontTools.designspaceLib import InstanceDescriptor

    for w in sorted(set([axis_min, 300, 400, 500, 600, 700, axis_max])):
        if w < axis_min or w > axis_max:
            continue
        inst = InstanceDescriptor()
        inst.familyName = family
        inst.styleName = {
            200: "ExtraLight",
            300: "Light",
            400: "Regular",
            500: "Medium",
            600: "SemiBold",
            700: "Bold",
            800: "ExtraBold",
        }[w]
        inst.name = f"instance-{w}"
        inst.location = {"Weight": w}
        ds.addInstance(inst)

    ds_path = OUT / f"{spec['slug']}.designspace"
    ds.write(ds_path)

    vf, _, _ = build_variable(str(ds_path))
    rename(vf, axis_default, is_variable=True, family=family)
    vf["OS/2"].usWeightClass = 400
    vf_path = OUT / spec["file"]
    vf.save(vf_path)
    print("variable:", vf_path, vf_path.stat().st_size)

    # The app bundles a Latin cut; the terminal installs the full binary.
    latin = Subsetter(options=Options())
    latin.options.flavor = "woff2"
    latin.options.layout_features = ["*"]
    latin.options.name_IDs = ["*"]
    latin.options.notdef_outline = True
    latin.options.recalc_bounds = True
    latin.options.desubroutinize = False
    latin.populate(unicodes=set(range(0x20, 0x7F)) | set(LATIN_EXTRA) | {0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x2192, 0x2190, 0x2713, 0x25CF, 0x00B7})
    web = TTFont(vf_path)
    latin.subset(web)
    woff_path = OUT / f"{spec['slug']}-latin.woff2"
    web.flavor = "woff2"
    web.save(woff_path)
    print("web:", woff_path, woff_path.stat().st_size)

    for p in OUT.glob("master-*.ttf"):
        p.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build one cut of the Oven family.")
    parser.add_argument("--variant", choices=sorted(VARIANTS), default="mono")
    build(parser.parse_args().variant)
