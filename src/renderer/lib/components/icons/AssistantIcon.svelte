<script lang="ts">
  import type { SVGAttributes } from 'svelte/elements'

  /**
   * Which job an assistant icon is doing. The body is always the same plush
   * shape, so a surface never draws a bare glyph: only what sits inside it
   * changes, and that inside mark is what names the job.
   */
  export type AssistantIconMark =
    | 'mark'
    | 'routine'
    | 'task'
    | 'run'
    | 'how-to'
    | 'connection'
    | 'agent'

  interface Props extends Omit<SVGAttributes<SVGSVGElement>, 'size'> {
    /** The inside mark that names the job. Defaults to the assistant itself. */
    mark?: AssistantIconMark
    size?: number | string
  }

  let { mark = 'mark', size = 24, class: className = '', ...rest }: Props = $props()

  /**
   * The drawn tier. A tier is a different drawing rather than a scale, because
   * the full drawing does not survive at rail size: the ear tufts become specks,
   * so they are dropped and the inside mark grows instead. The tiers are the
   * agreed ones: 24 px is the rail, 40 px is anything larger, and 168 px is the
   * largest surfaces.
   */
  type Tier = 'rail' | 'medium' | 'large'

  const MEDIUM_MIN_SIZE = 32
  const LARGE_MIN_SIZE = 64

  let numericSize = $derived(typeof size === 'number' ? size : Number.parseFloat(size))

  let tier = $derived<Tier>(
    !Number.isFinite(numericSize) || numericSize < MEDIUM_MIN_SIZE
      ? 'rail'
      : numericSize < LARGE_MIN_SIZE
        ? 'medium'
        : 'large'
  )

  /** Full drawing keeps crisp thin strokes; the rail glyph needs a heavier one. */
  let strokeWidth = $derived(tier === 'rail' ? 1.8 : tier === 'medium' ? 1.6 : 1.15)
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  {...rest}
  stroke-width={strokeWidth}
>
  {#if tier !== 'rail'}
    <!-- Ear tufts. Drawn as circles so the ears and the body share one soft
         language, and omitted at rail size where they would only be specks. -->
    <circle cx="7.8" cy="5" r="1.7" />
    <circle cx="16.2" cy="5" r="1.7" />
  {/if}

  <rect x={tier === 'rail' ? 4.2 : 3.8} y={tier === 'rail' ? 6.4 : 5.8} width={tier === 'rail' ? 15.6 : 16.4} height={tier === 'rail' ? 12.4 : 13.6} rx={tier === 'rail' ? 6 : 6.2} />

  {#if mark === 'mark'}
    <!-- The assistant itself. The largest tier adds the mouth, because a face
         needs room for a third dot and only the top tier has it. -->
    {#if tier === 'large'}
      <circle cx="9.2" cy="11.8" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="14.8" cy="11.8" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="15.4" r="1.05" fill="currentColor" stroke="none" />
    {:else}
      <circle cx="9.4" cy="12.4" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="14.6" cy="12.4" r="1.5" fill="currentColor" stroke="none" />
    {/if}
  {:else if mark === 'routine'}
    <!-- A repeat ring: this happens again and again on a clock. -->
    <path d="M8.6 12.6a3.6 3.6 0 1 0 1.3-2.8" />
    <path d="M8.4 8.6v2.6h2.6" />
  {:else if mark === 'task'}
    <!-- Two soft lines: a piece of work that was asked for. -->
    <path d="M8.6 10.6h6.8" />
    <path d="M8.6 14h4.4" />
  {:else if mark === 'run'}
    <!-- A soft play mark: one execution of a task, on its own thread. -->
    <path d="M10.6 9.4l4.6 3.1-4.6 3.1z" />
  {:else if mark === 'how-to'}
    <!-- A page: the instructions the routine is told to follow. -->
    <path d="M8.4 9.6h7.2" />
    <path d="M8.4 12.6h7.2" />
    <path d="M8.4 15.6h4" />
  {:else if mark === 'connection'}
    <!-- Two joined ends: the services this routine reaches out to. -->
    <path d="M10 12h4" />
    <circle cx="8.6" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="15.4" cy="12" r="1.4" fill="currentColor" stroke="none" />
  {:else if mark === 'agent'}
    <!-- A visor and two eyes: which model does the work. -->
    <path d="M8.8 10.4h6.4" />
    <circle cx="10.5" cy="13.6" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="13.5" cy="13.6" r="1.1" fill="currentColor" stroke="none" />
  {/if}
</svg>
