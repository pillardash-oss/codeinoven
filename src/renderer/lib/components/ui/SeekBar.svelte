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
    /** The accessible name, and the tooltip when `title` is not given. */
    label: string
    title?: string
    /**
     * Every move, so a scrub follows the thumb.
     *
     * A caller that pins the playhead on release only should treat this as a
     * preview; `onCommit` is where the settled value arrives.
     */
    onInput: (value: number) => void
    /** The value the user settled on, on release. */
    onCommit?: (value: number) => void
    /** Extra layout classes, such as the width the caller's row gives it. */
    class?: string
    disabled?: boolean
  }

  let {
    value,
    min,
    max,
    step = 0.01,
    label,
    title = label,
    onInput,
    onCommit,
    class: layout = '',
    disabled = false
  }: Props = $props()

  /** How much of the track is behind the head, as the gradient's stop. */
  const fill = $derived(
    `${Math.min(100, Math.max(0, ((value - min) / Math.max(max - min, 1e-6)) * 100))}%`
  )
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
