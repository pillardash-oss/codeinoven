<script lang="ts">
  import type { Snippet } from 'svelte'
  import CardTag from './CardTag.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'

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

  /*
    The frame is one choice, so the whole box is one target: the label row and the
    explanation under it highlight together, and the explanation selects the
    option as the label does.

    The explanation cannot live inside the button, because it is markdown and a
    live link inside a button is invalid (and would choose the option instead of
    opening). So that block carries the click itself and leaves alone the two
    things it is there for: a click that landed on a link, and a drag that
    selected text to copy.
  */
  const choiceColumnClass = 'group/choice min-w-0 flex-1'
  const descriptionClass = $derived(
    [
      'px-2.5 pb-2.5 text-[0.6875rem] leading-relaxed text-muted',
      onclick ? 'cursor-pointer' : '',
      onclick && !selected ? 'group-hover/choice:bg-elevated' : ''
    ].join(' ')
  )

  function chooseFromExplanation(event: MouseEvent): void {
    if (!onclick || disabled) return
    const target = event.target
    if (target instanceof Element && target.closest('a')) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    onclick()
  }
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
    {@render children?.()}
  </span>
{/snippet}

<!-- The design's option box: one framed choice with its label and its explanation,
and the selected state carried by the frame rather than by a fill. -->
<div class={frameClass}>
  <div class={choiceColumnClass}>
    {#if onclick}
      <button
        type="button"
        class="{bodyClass} w-full {!selected ? 'group-hover/choice:bg-elevated' : ''}"
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
    {#if description}
      <div class={descriptionClass} role="presentation" onclick={chooseFromExplanation}>
        <MarkdownView text={description} class="markdown-body-card" />
      </div>
    {/if}
  </div>
  {@render trailing?.()}
</div>
