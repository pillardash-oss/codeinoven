"""
Build Oven Mono: a real variable font for CodeInOven, derived from JetBrains Mono
(SIL OFL 1.1) and finished with the brand mark's construction.

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

Nothing here redraws a letter. The build instances JetBrains Mono at four weights,
replaces the dot glyphs, and assembles a wght axis from those masters, so the family is
a real font a terminal, an editor and a browser can all install.

Run, from the project root:
  .cio/tmp/typeface/venv/bin/python docs/designs/brand-typeface/tools/build-family.py
  .cio/tmp/typeface/venv/bin/python docs/designs/brand-typeface/tools/verify-family.py
then copy the two written files from .cio/tmp/typeface/out into fonts/.
"""

from __future__ import annotations

import math
import shutil
from pathlib import Path

from fontTools.designspaceLib import AxisDescriptor, DesignSpaceDocument, SourceDescriptor
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import build as build_variable
from fontTools.varLib.instancer import instantiateVariableFont

PROJECT = Path(__file__).resolve().parents[4]
SOURCE = PROJECT / ".cio" / "tmp" / "typeface" / "source" / "jbm" / "fonts" / "variable" / "JetBrainsMono[wght].ttf"
OUT = PROJECT / ".cio" / "tmp" / "typeface" / "out"

MASTERS = [300, 400, 600, 800]

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

# A square reads heavier than a circle of equal area, so the side is a little under the
# circle's diameter: 0.86 puts the two on the same optical mass at text size. A dot that
# is not round to begin with is squared on its own mean dimension.
SQUARE_RATIO = 0.86

FAMILY = "Oven Mono"
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


def rename(font: TTFont, weight: int, is_variable: bool):
    name = font["name"]
    style = {300: "Light", 400: "Regular", 600: "SemiBold", 800: "ExtraBold"}
    sub = "Variable" if is_variable else style[weight]
    family = FAMILY
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


def build():
    OUT.mkdir(parents=True, exist_ok=True)
    plan = plan_dots()
    print("dot plan:", plan)
    masters = []
    for w in MASTERS:
        f = TTFont(SOURCE)
        inst = instantiateVariableFont(f, {"wght": w}, inplace=True, updateFontNames=False)
        changed = redraw_dots(inst, w, plan)
        square_zero_dot(inst)
        bars = flat_bars(inst)
        rename(inst, w, is_variable=False)
        path = OUT / f"master-{w}.ttf"
        inst.save(path)
        masters.append((w, path))
        print(f"master {w}: dots {changed} bars {bars}")

    ds = DesignSpaceDocument()
    axis = AxisDescriptor()
    axis.name = "Weight"
    axis.tag = "wght"
    axis.minimum = MASTERS[0]
    axis.default = 400
    axis.maximum = MASTERS[-1]
    axis.map = [(w, w) for w in MASTERS]
    ds.addAxis(axis)

    for w, path in masters:
        src = SourceDescriptor()
        src.path = str(path)
        src.name = f"master-{w}"
        src.location = {"Weight": w}
        if w == 400:
            src.copyInfo = True
            src.copyLib = True
            src.copyFeatures = True
        ds.addSource(src)

    for w in (300, 400, 500, 600, 700, 800):
        inst = DesignSpaceDocument.InstanceDescriptor() if hasattr(DesignSpaceDocument, "InstanceDescriptor") else None
        from fontTools.designspaceLib import InstanceDescriptor

        inst = InstanceDescriptor()
        inst.familyName = FAMILY
        inst.styleName = {300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold"}[w]
        inst.name = f"instance-{w}"
        inst.location = {"Weight": w}
        ds.addInstance(inst)

    ds_path = OUT / "OvenMono.designspace"
    ds.write(ds_path)

    vf, _, _ = build_variable(str(ds_path))
    rename(vf, 400, is_variable=True)
    vf["OS/2"].usWeightClass = 400
    vf_path = OUT / "OvenMono[wght].ttf"
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
    woff_path = OUT / "oven-mono-latin.woff2"
    web.flavor = "woff2"
    web.save(woff_path)
    print("web:", woff_path, woff_path.stat().st_size)

    for p in OUT.glob("master-*.ttf"):
        p.unlink()


if __name__ == "__main__":
    build()
