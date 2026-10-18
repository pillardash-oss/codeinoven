"""Cut the static faces the native splash draws its Oven Mono lockup with.

The native splash is rasterised at packaging time by scripts/native-splash/artwork.js
through resvg. resvg reads plain TTF/OTF only, so a WOFF2 source renders as nothing
at all, and it draws a variable font at the axis default whatever `font-weight` the
artwork asks for. The Oven Box prose face and Oven Mono wordmark face are therefore cut
here as static faces and committed beside the family build, which keeps packaging free
of Python.

Run with the font build environment:
  .cio/tmp/typeface/venv/bin/python scripts/build-native-splash-fonts.py
Only fontTools and brotli (already used by the font builder) are required.

The lockup draws Latin text only, so each face is subset to printable ASCII plus the
Latin-1 supplement to keep two faces well under the full family. Widen CODEPOINTS if
the copy ever needs another script.

artwork.js verifies both source families and every generated face before it renders,
so a rebuilt family cannot leave the splash drawing a stale wordmark.
"""
from hashlib import sha256
from json import dumps
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE_BOX = ROOT / 'resources/fonts/oven/oven-box.woff2'
SOURCE_MONO = ROOT / 'resources/fonts/oven/oven-mono.woff2'
OUTPUT = ROOT / 'resources/fonts/oven/native'
# Body copy keeps the UI face; the official wordmark uses Oven Mono at 800.
FACES = (
    (SOURCE_BOX, 'Oven Box', 400, 'Regular'),
    (SOURCE_MONO, 'Oven Mono', 800, 'ExtraBold'),
)
CODEPOINTS = list(range(0x20, 0x7F)) + list(range(0xA1, 0x100))


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def cut(source: Path, family: str, weight: int, subfamily: str) -> Path:
    font = instantiateVariableFont(TTFont(source), {'wght': weight}, inplace=True,
                                   updateFontNames=False)
    # The builder leaves the STAT table without a name for every axis value but
    # Regular, so the names are set here rather than through updateFontNames.
    name = font['name']
    family_slug = family.replace(' ', '')
    for name_id, value in ((1, family), (2, subfamily), (4, f'{family} {subfamily}'),
                           (6, f"{family_slug}-{subfamily.replace(' ', '')}"),
                           (16, family), (17, subfamily)):
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
    # a face. Held still, a re-cut of an unchanged source is a no-op and a face
    # that really did change is the only thing the digest ever reports.
    font.recalcTimestamp = False

    target = OUTPUT / f"{family_slug}-{subfamily.replace(' ', '')}.ttf"
    font.save(target)
    return target


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    expected_files = {
        f"{family.replace(' ', '')}-{subfamily.replace(' ', '')}.ttf"
        for _, family, _, subfamily in FACES
    }
    for stale in OUTPUT.glob('*.ttf'):
        if stale.name not in expected_files:
            stale.unlink()

    faces = []
    sources = {}
    for source, family, weight, subfamily in FACES:
        sources[family] = {'file': source.name, 'sha256': digest(source)}
        path = cut(source, family, weight, subfamily)
        faces.append({'family': family, 'file': path.name, 'weight': weight,
                      'sha256': digest(path)})
        print(f'{path.relative_to(ROOT)}  {path.stat().st_size} bytes  wght {weight}')
    manifest = {
        'generator': 'scripts/build-native-splash-fonts.py',
        'sources': sources,
        'codepoints': 'U+0020-U+007E, U+00A1-U+00FF',
        'faces': faces
    }
    (OUTPUT / 'instances.json').write_text(dumps(manifest, indent=2) + '\n')
    print(f'{manifest["codepoints"]} in {len(faces)} faces')


if __name__ == '__main__':
    main()
