<script lang="ts">
  /**
   * The app's one seek track.
   *
   * A playhead reads the same wherever it is drawn: a two-tone rule whose filled
   * part is what is behind the head, with a small solid thumb on it. It began as a
   * class inside the composition transport and a second copy in the spoken-audio
   * bar; the look belongs to the app rather than to either surface, so the styles
   * live here and the callers pass the numbers.
   *
   * The element is a range input on purpose: keyboard seeking, the arrow-key step
   * and the accessibility tree all come with it, and the styling is the only thing
   * that had to be written.
   */
  interface Props {
    /** Where the head is, in the caller's own units. */
    value: number
    min: number
    max: number
    step?: number
    /**
     * The move a left/right arrow makes, when it should not be one `step`.
     *
     * Absent means one `step`, which is the element's own stepping.
     */
    arrowStep?: number
    /**
     * The move Shift with a left/right arrow makes.
     *
     * It is the fine move beside the coarse `arrowStep`, so a caller can offer
     * a jump and a single frame from the same track. Absent means one `step`.
     */
    fineStep?: number
    /**
     * Fired when an arrow key moves the head, before the move is applied.
     *
     * A caller that holds something down for the length of a gesture (a video
     * player silencing its track) arms it here, because the press is taken in
     * this element and never reaches the caller's own markup.
     */
    onKeyStep?: () => void
    /** The accessible name, and the tooltip when `title` is not given. */
    label: string
    title?: string
    /**
     * How much of the track is drawn as filled, as a share of the whole.
     *
     * Absent means the fill follows the head, which is what a plain playhead
     * wants. Spoken audio passes its synthesized frontier here instead, because
     * there the fill answers "how much of this can play" while the head answers
     * "where am I".
     */
    fillRatio?: number
    /**
     * Every move, so a scrub follows the thumb.
     *
     * A caller that pins the playhead on release only should treat this as a
     * preview; `onCommit` is where the settled value arrives.
     */
    onInput: (value: number) => void
    /** The value the user settled on, on release. */
    onCommit?: (value: number) => void
    /** A pointer landing on the track, where a caller starts its own scrub session. */
    onScrubStart?: (value: number) => void
    /** The pointer leaving the track, before the settled value is committed. */
    onScrubEnd?: () => void
    /** Extra layout classes, such as the width the caller's row gives it. */
    class?: string
    disabled?: boolean
  }

  let {
    value,
    min,
    max,
    step = 0.01,
    arrowStep,
    fineStep,
    label,
    title = label,
    fillRatio,
    onInput,
    onCommit,
    onKeyStep,
    onScrubStart,
    onScrubEnd,
    class: layout = '',
    disabled = false
  }: Props = $props()

  /** How much of the track is filled, as the gradient's stop. */
  const fill = $derived(
    `${Math.min(100, Math.max(0, (fillRatio ?? (value - min) / Math.max(max - min, 1e-6)) * 100))}%`
  )

  /**
   * Move the head by a caller's keyboard step.
   *
   * The element steps by one `step` on an arrow key, which is the fine move of
   * a video track rather than the one a scrutinizing hand wants; naming the two
   * strides lets the press be taken here instead. The move stays on the track's
   * own grid, so repeated presses do not drift off it, and page up/down, home
   * and end are still the element's.
   */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const stride = event.shiftKey ? (fineStep ?? step) : (arrowStep ?? step)
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement)) return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    onKeyStep?.()
    const moved = min + Math.round((Number(input.value) + direction * stride - min) / step) * step
    const next = Math.min(max, Math.max(min, moved))
    onInput(next)
    // The head follows the press at once, and the next repeat of a held key reads
    // this landing rather than the position the element was still drawing, which
    // is what makes a run of presses accumulate instead of landing on one frame.
    input.value = String(next)
    onCommit?.(next)
  }
</script>

<input
  class="seek-bar cursor-pointer {layout}"
  style={`--fill:${fill}`}
  type="range"
  {min}
  {max}
  {step}
  {value}
  {disabled}
  aria-label={label}
  {title}
  onpointerdown={() => onScrubStart?.(value)}
  onpointerup={() => onScrubEnd?.()}
  onpointercancel={() => onScrubEnd?.()}
  onkeydown={onKeydown}
  oninput={(event) => onInput(Number(event.currentTarget.value))}
  onchange={(event) => onCommit?.(Number(event.currentTarget.value))}
/>

<style>
  .seek-bar {
    appearance: none;
    -webkit-appearance: none;
    height: 4px;
    background: linear-gradient(
      to right,
      var(--color-primary) 0%,
      var(--color-primary) var(--fill, 0%),
      var(--color-border) var(--fill, 0%),
      var(--color-border) 100%
    );
    outline-offset: 3px;
  }
  .seek-bar:focus-visible {
    outline: 2px solid var(--color-info);
  }
  .seek-bar:disabled {
    cursor: default;
    opacity: 0.4;
  }
  .seek-bar::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    height: 10px;
    width: 10px;
    background: var(--color-primary);
    border: none;
    box-shadow: 0 0 0 1px var(--color-app);
    cursor: pointer;
  }
  .seek-bar::-moz-range-thumb {
    height: 10px;
    width: 10px;
    background: var(--color-primary);
    border: none;
    box-shadow: 0 0 0 1px var(--color-app);
    cursor: pointer;
  }
</style>
