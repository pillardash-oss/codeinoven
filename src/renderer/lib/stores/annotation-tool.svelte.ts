import {
  MARK_DEFAULT_STROKE_WIDTH,
  accentMarkColor,
  clampMarkStrokeWidth
} from '$lib/annotation-marks'

/**
 * The drawing tool every annotation surface shares.
 *
 * One colour and one stroke width for the whole app rather than one per surface,
 * because the user is doing one thing: pointing at something and saying what is
 * wrong with it. A mark drawn on a picture and a mark drawn on a video frame are
 * the same note in different places, so switching surface must not silently
 * change the pen.
 *
 * The stroke default is a width wide enough to read over a photograph without
 * covering what it points at. The colour is not stored as a default at all: until
 * the user chooses one the pen follows the app's accent, resolved when it is read
 * rather than when this module loads, so a theme change cannot leave the first
 * mark of a session drawn in a colour the app stopped using. Both survive for the
 * session rather than being written to config, because a pen is a working
 * preference rather than a setting.
 */
class AnnotationToolState {
  /** The colour the user chose, or null while the pen follows the app accent. */
  chosenColor = $state<string | null>(null)
  /** The stroke width, in CSS pixels, of the next mark. */
  strokeWidth = $state(MARK_DEFAULT_STROKE_WIDTH)

  /** The colour the next mark is drawn in: the user's choice, else the accent. */
  get color(): string {
    return this.chosenColor ?? accentMarkColor()
  }

  /** Choose a colour, or hand the pen back to the accent for an empty value. */
  setColor(color: string): void {
    const trimmed = color.trim()
    this.chosenColor = trimmed ? trimmed : null
  }

  setStrokeWidth(width: number): void {
    this.strokeWidth = clampMarkStrokeWidth(width)
  }
}

export const annotationTool = new AnnotationToolState()
