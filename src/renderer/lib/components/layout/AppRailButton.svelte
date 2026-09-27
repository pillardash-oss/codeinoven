<script lang="ts">
  import type { Component, Snippet } from 'svelte'

  interface Props {
    /** Accessible name and tooltip text. */
    label: string
    icon: Component
    /** Marks the item as the current destination: raised surface plus accent bar. */
    active?: boolean
    disabled?: boolean
    /** Symbolic key tokens from the keymap registry, shown in the tooltip chip. */
    shortcut?: readonly string[]
    /** Icon colour when the item is idle. */
    tone?: 'default' | 'primary' | 'danger' | 'accent'
    /** Spins the icon, for in-flight states such as a download. */
    spin?: boolean
    onSelect: () => void
    onHover?: () => void
    /** Corner content, e.g. an activity badge. */
    badge?: Snippet
  }

  let {
    label,
    icon: Icon,
    active = false,
    disabled = false,
    shortcut = [],
    tone = 'default',
    spin = false,
    onSelect,
    onHover,
    badge
  }: Props = $props()

  /** Tonal items keep their colour in every state; the rest use the neutral
   *  idle/active palette shared by the view rail and the context dock. */
  const toneClass = $derived.by((): string => {
    if (active) return 'bg-elevated text-foreground'
    switch (tone) {
      case 'primary':
        return 'text-primary hover:bg-elevated'
      case 'danger':
        return 'text-danger hover:bg-elevated'
      case 'accent':
        return 'text-accent'
      default:
        return 'text-muted hover:bg-elevated hover:text-foreground'
    }
  })
</script>

<!-- One rail item: the 32px tool button shared by the view rail's views and its
     utility controls, including the accent bar that marks the current item. -->
<button
  type="button"
  class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 {toneClass}"
  aria-label={label}
  aria-current={active ? 'page' : undefined}
  title={label}
  data-shortcut={shortcut.length > 0 ? shortcut.join(',') : undefined}
  {disabled}
  onpointerenter={onHover}
  onclick={onSelect}
>
  <span
    class="absolute right-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary transition-opacity duration-150 {active
      ? 'opacity-100'
      : 'opacity-0'}"
    aria-hidden="true"
  ></span>
  <Icon size={16} strokeWidth={1.8} class={spin ? 'animate-spin' : undefined} />
  {@render badge?.()}
</button>
