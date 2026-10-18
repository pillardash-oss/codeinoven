<script lang="ts">
  import type { Snippet } from 'svelte'
  import CardTag from './CardTag.svelte'

  interface Props {
    /** Option label, the line the user picks by. */
    title: string
    /** One line under the label that explains the choice. */
    description?: string
    /** The chosen state: the frame inks and takes the design's 2px mark. */
    selected?: boolean
    disabled?: boolean
    /** A tag beside the label, such as Recommended. */
    badge?: { text: string; tone?: 'ok' | 'warn' | 'err' | 'info' }
    /** Extra lines under the description, e.g. a mono path. */
    children?: Snippet
    /** Draws the label in the mono face, for an option that names a path. */
    mono?: boolean
    /** A control attached to the box's right edge, such as an instruction button. */
    trailing?: Snippet
    /** Omit to render a static option the user is only reading. */
    onclick?: () => void
    /** Marks a multi-select option, which needs its own square marker. */
    multiple?: boolean
    class?: string
  }

  let {
    title,
    description,
    selected = false,
    disabled = false,
    badge,
    children,
    mono = false,
    trailing,
    onclick,
    multiple = false,
    class: className = ''
  }: Props = $props()

  /*
    The 2px mark is always on the box and only changes colour, so choosing an
    option inks the edge in instead of snapping a bar into place. It is drawn as
    an inset shadow rather than a border because a border would shift the label
    two pixels sideways every time the choice changed.
  */
  const frameClass = $derived(
    [
      'flex min-h-11 w-full items-stretch border transition-[box-shadow,border-color,background-color] duration-150',
      selected
        ? 'border-primary shadow-[inset_2px_0_0_var(--color-primary)]'
        : 'border-border bg-surface shadow-[inset_2px_0_0_transparent] hover:border-border-strong',
      className
    ].join(' ')
  )

  const bodyClass =
    'flex min-w-0 flex-1 items-start gap-2.5 p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50'
</script>

{#snippet optionBody()}
  {#if multiple}
    <span
      class="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border text-[0.5625rem] transition-colors {selected
        ? 'border-primary bg-primary text-on-primary'
        : 'border-border-strong'}"
      aria-hidden="true"
    >
      {#if selected}✓{/if}
    </span>
  {/if}
  <span class="min-w-0 flex-1">
    <span
      class="flex flex-wrap items-center gap-1.5 {mono
        ? 'font-mono text-[0.6875rem] font-medium'
        : 'text-xs font-semibold'} text-foreground"
    >
      {title}
      {#if badge}
        <CardTag text={badge.text} tone={badge.tone ?? 'ok'} />
      {/if}
    </span>
    {#if description}
      <span class="mt-0.5 block text-[0.6875rem] leading-relaxed text-muted">{description}</span>
    {/if}
    {@render children?.()}
  </span>
{/snippet}

<!-- The design's option box: one framed choice with its label and its explanation,
and the selected state carried by the frame rather than by a fill. -->
<div class={frameClass}>
  {#if onclick}
    <button
      type="button"
      class="{bodyClass} {!selected ? 'hover:bg-elevated' : ''}"
      {disabled}
      aria-pressed={selected}
      {onclick}
    >
      {@render optionBody()}
    </button>
  {:else}
    <div class={bodyClass}>
      {@render optionBody()}
    </div>
  {/if}
  {@render trailing?.()}
</div>
