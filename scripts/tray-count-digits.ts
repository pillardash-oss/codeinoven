/**
 * The menu bar numerals, drawn by hand.
 *
 * These are not typeset and not taken from a text face. They are drawn in the
 * mark's own vocabulary, read off `src/renderer/static/icon-mono-small.svg`: one
 * uniform heavy stroke, square terminals, mitred corners, and a rectilinear
 * skeleton. The mark is a squared C/O, so numerals built from bars that turn at
 * right angles are the same voice rather than a second one borrowed from a font.
 *
 * Two rules keep a figure reading as the same object as the mark at menu bar
 * size:
 *
 *   weight     every stroke is the mark's weight. Nothing is thinned to make a
 *              counter fit, because a thin stroke next to the mark reads as a
 *              different material.
 *   counter    the daylight inside a glyph is at least 1.5x the stroke. Below
 *              that the counters grey out at 16px and a 6, an 8 and a 9 start to
 *              look alike.
 *
 * A glyph is a skeleton drawn on a grid inset by half a stroke, so a mitred
 * corner lands exactly on the box corner and a square terminal lands exactly on
 * the box edge. Nothing is drawn outside the box, which is what lets the layout
 * compute a cell width from the glyph count alone.
 *
 * The box and the stroke come from `src/lib/tray-count-art.ts`, so the drawings
 * and the grid cannot disagree about the size they are drawn at.
 */
import { TRAY_COUNT_GLYPH } from '../src/lib/tray-count-art'

/** Half a stroke: the inset that puts ink exactly on the box edge. */
const HALF = TRAY_COUNT_GLYPH.stroke / 2

/** The skeleton grid: the centres of the outermost strokes, and the middle. */
const LEFT = HALF
const RIGHT = TRAY_COUNT_GLYPH.width - HALF
const TOP = HALF
const BOTTOM = TRAY_COUNT_GLYPH.capHeight - HALF
const MIDDLE = TRAY_COUNT_GLYPH.capHeight / 2

/**
 * The plus sign. Its arms are shorter than a digit and sit on the middle line,
 * so it reads as a sign rather than as another numeral, while its stroke stays
 * the mark's weight.
 */
const PLUS_ARM = 22
const PLUS_LEFT = (TRAY_COUNT_GLYPH.width - PLUS_ARM) / 2
const PLUS_RIGHT = PLUS_LEFT + PLUS_ARM
const PLUS_TOP = MIDDLE - PLUS_ARM / 2
const PLUS_BOTTOM = MIDDLE + PLUS_ARM / 2

/** One drawn glyph: what it is, and the strokes that make it. */
interface DrawnNumeral {
  note: string
  /** Skeleton paths, drawn with no fill at the mark's weight. */
  paths: readonly string[]
}

/**
 * The numerals, 0 to 9, plus the overflow sign.
 *
 * Read the segments as a seven-segment skeleton: the shapes are the classic
 * segment sets, but each digit is one continuous path wherever its segments meet,
 * so the joins are mitred into a single slab instead of reading as bars stacked
 * on top of each other. A segment that ends in open space keeps a square
 * terminal, which is where a digit's shape comes from.
 */
export const TRAY_COUNT_NUMERALS: Readonly<Record<string, DrawnNumeral>> = {
  '0': {
    note: 'The squared O of the mark, closed: four mitred corners and nothing else, so it can never be mistaken for the 8 with its middle bar.',
    paths: [`M ${LEFT} ${TOP} H ${RIGHT} V ${BOTTOM} H ${LEFT} Z`]
  },
  '1': {
    note: 'A stem with a short flag at the top-left. A bare stem is the exclamation mark the figure replaces, and a foot turns the glyph into a J at menu bar size, so the flag is the only mark that reads as a 1 without impersonating another glyph. It stays short on purpose: a full-width bar here is the 7.',
    paths: [`M ${RIGHT} ${TOP} V ${BOTTOM}`, `M ${RIGHT - 8} ${TOP} H ${RIGHT}`]
  },
  '2': {
    note: 'One path: top bar, right shoulder, middle bar, left leg, foot. The only glyph whose top-left is an open terminal.',
    paths: [`M ${LEFT} ${TOP} H ${RIGHT} V ${MIDDLE} H ${LEFT} V ${BOTTOM} H ${RIGHT}`]
  },
  '3': {
    note: 'The top, right and bottom bars as one mitred path, with the middle bar meeting the right bar as a T, which is what keeps the two right-hand corners sharp.',
    paths: [`M ${LEFT} ${TOP} H ${RIGHT} V ${BOTTOM} H ${LEFT}`, `M ${RIGHT} ${MIDDLE} H ${LEFT}`]
  },
  '4': {
    note: 'An open top-left corner, the middle bar, and a full-height stem. Every segment is square-terminated, which is what makes a 4 unmistakable.',
    paths: [`M ${LEFT} ${TOP} V ${MIDDLE} H ${RIGHT}`, `M ${RIGHT} ${TOP} V ${BOTTOM}`]
  },
  '5': {
    note: 'The 2 read from the other end, so the top-left corner is mitred and the foot is open.',
    paths: [`M ${RIGHT} ${BOTTOM} V ${MIDDLE} H ${LEFT} V ${TOP} H ${RIGHT}`]
  },
  '6': {
    note: 'A closed bowl below the middle line plus a top bar: the bowl is what separates it from the 5, which stays open on that side.',
    paths: [`M ${RIGHT} ${TOP} H ${LEFT} V ${BOTTOM} H ${RIGHT} V ${MIDDLE} H ${LEFT}`]
  },
  '7': {
    note: 'A full top bar and a stem, with no foot. The top bar is the whole difference from the 1.',
    paths: [`M ${LEFT} ${TOP} H ${RIGHT} V ${BOTTOM}`]
  },
  '8': {
    note: 'The 0 with a middle bar, so the two share a silhouette and the middle is the only thing that distinguishes them.',
    paths: [`M ${LEFT} ${TOP} H ${RIGHT} V ${BOTTOM} H ${LEFT} Z`, `M ${LEFT} ${MIDDLE} H ${RIGHT}`]
  },
  '9': {
    note: 'The 6 turned over: a closed bowl above the middle line, a full right stem, and a bottom bar that closes the foot.',
    paths: [`M ${LEFT} ${BOTTOM} H ${RIGHT} V ${TOP} H ${LEFT} V ${MIDDLE} H ${RIGHT}`]
  },
  '+': {
    note: 'A sign rather than a numeral: the same stroke at a shorter arm, centred on the middle line so 99+ reads as one number plus an overflow.',
    paths: [
      `M ${PLUS_LEFT} ${MIDDLE} H ${PLUS_RIGHT}`,
      `M ${TRAY_COUNT_GLYPH.width / 2} ${PLUS_TOP} V ${PLUS_BOTTOM}`
    ]
  }
}

/** The strokes for one character of a figure, in the glyph's own box. */
export function trayNumeralPaths(character: string): readonly string[] {
  const numeral = TRAY_COUNT_NUMERALS[character]
  if (!numeral) throw new Error(`No menu bar numeral drawn for "${character}"`)
  return numeral.paths
}
