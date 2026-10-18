"""Cut the static Oven Box faces the native splash draws its lockup with.

The native splash is rasterised at packaging time by scripts/native-splash/artwork.js
through resvg. resvg reads plain TTF/OTF only, so a WOFF2 source renders as nothing
at all, and it draws a variable font at the axis default whatever `font-weight` the
artwork asks for. Both weights the lockup uses are therefore cut here as static faces
and committed beside the family build, which also keeps packaging free of Python.

Run with the font build environment:
  .cio/tmp/typeface/venv/bin/python scripts/build-native-splash-fonts.py
Only fontTools and brotli (already used by the font builder) are required.

The lockup draws Latin text only, so each face is subset to printable ASCII plus the
Latin-1 supplement to keep two faces well under the full family. Widen CODEPOINTS if
the copy ever needs another script.

artwork.js verifies the manifest written here before it renders, so a rebuilt
Oven Box cannot leave the splash drawing a stale face.
"""
from hashlib import sha256
from json import dumps
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'resources/fonts/oven/oven-box.woff2'
OUTPUT = ROOT / 'resources/fonts/oven/native'
FAMILY = 'Oven Box'
# 400 is the prose of the lockup, 800 is the wordmark: the brand's own weight
# scale puts the wordmark at 800 and nothing else there.
FACES = ((400, 'Regular'), (800, 'ExtraBold'))
CODEPOINTS = list(range(0x20, 0x7F)) + list(range(0xA1, 0x100))


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def cut(weight: int, subfamily: str) -> Path:
    font = instantiateVariableFont(TTFont(SOURCE), {'wght': weight}, inplace=True,
                                   updateFontNames=False)
    # The builder leaves the STAT table without a name for every axis value but
    # Regular, so the names are set here rather than through updateFontNames.
    name = font['name']
    for name_id, value in ((1, FAMILY), (2, subfamily), (4, f'{FAMILY} {subfamily}'),
                           (6, f"OvenBox-{subfamily.replace(' ', '')}"),
                           (16, FAMILY), (17, subfamily)):
        name.setName(value, name_id, 3, 1, 0x409)
    font['OS/2'].usWeightClass = weight
    # Instancing leaves the woff2 flavour on the object, which would write a
    # compressed file that resvg cannot read behind a .ttf name.
    font.flavor = None

    options = subset.Options()
    options.layout_features = ['*']
    options.name_IDs = ['*']
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=CODEPOINTS)
    subsetter.subset(font)

    # fontTools restamps `head.modified` on every save, so the same build wrote
    # different bytes each run and the manifest below pinned a timestamp instead of
    # a face. Held still, a re-cut of an unchanged Oven Box is a no-op and a face
    # that really did change is the only thing the digest ever reports.
    font.recalcTimestamp = False

    target = OUTPUT / f"OvenBox-{subfamily.replace(' ', '')}.ttf"
    font.save(target)
    return target


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    faces = []
    for weight, subfamily in FACES:
        path = cut(weight, subfamily)
        faces.append({'file': path.name, 'weight': weight, 'sha256': digest(path)})
        print(f'{path.relative_to(ROOT)}  {path.stat().st_size} bytes  wght {weight}')
    manifest = {
        'generator': 'scripts/build-native-splash-fonts.py',
        'source': {'file': SOURCE.name, 'sha256': digest(SOURCE)},
        'codepoints': 'U+0020-U+007E, U+00A1-U+00FF',
        'faces': faces
    }
    (OUTPUT / 'instances.json').write_text(dumps(manifest, indent=2) + '\n')
    print(f'{manifest["codepoints"]} in {len(faces)} faces')


if __name__ == '__main__':
    main()
