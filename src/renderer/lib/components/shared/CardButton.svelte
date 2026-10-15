<script lang="ts">
  import type { Component } from 'svelte'

  /**
   * The card button, in the design's ladder:
   *
   * - `secondary`  a bordered surface button for a neutral choice
   * - `primary`    the card's one truthy action
   * - `ghost`      cancel, dismiss, not now: no border, muted
   * - `ghost-danger` the same shape for a destructive falsy action, red on hover
   * - `danger`     a bordered red button for stopping live work
   */
  type CardButtonVariant =
    'secondary' | 'primary' | 'ghost' | 'ghost-text' | 'ghost-danger' | 'danger'

  interface Props {
    /** Visible label; always present, so the button never reads as icon only. */
    label: string
    /** Tooltip and accessible name; defaults to the label. */
    title?: string
    icon?: Component
    variant?: CardButtonVariant
    /**
     * `sm` for the chat actions that share a card foot with bigger controls,
     * `xs` for a dressed button that has to fit a card head.
     */
    size?: 'md' | 'sm' | 'xs'
    disabled?: boolean
    /** Renders a spinner-sized gap before the label while work is in flight. */
    loading?: boolean
    onclick?: (event: MouseEvent) => void
    class?: string
  }

  let {
    label,
    title,
    icon,
    variant = 'secondary',
    size = 'md',
    disabled = false,
    loading = false,
    onclick,
    class: className = ''
  }: Props = $props()

  const VARIANT_CLASS: Record<CardButtonVariant, string> = {
    secondary: 'border-border-strong bg-surface text-foreground hover:bg-elevated',
    primary: 'border-primary bg-primary text-on-primary hover:bg-primary-hover',
    ghost: 'border-transparent bg-transparent text-muted hover:bg-elevated hover:text-foreground',
    'ghost-text':
      'border-transparent border-0 bg-transparent text-muted hover:bg-elevated hover:text-foreground',
    'ghost-danger':
      'border-transparent bg-transparent text-muted hover:bg-danger/10 hover:text-danger',
    danger: 'border-danger text-danger hover:bg-danger/10'
  }

  const variantClass = $derived(VARIANT_CLASS[variant])

  const sizeClass = $derived(
    size === 'xs'
      ? 'h-6 px-1.5 text-[0.6875rem]'
      : size === 'sm'
        ? 'h-7 px-2 text-[0.6875rem]'
        : 'h-8 px-2.5 text-xs'
  )
  const iconSize = $derived(size === 'xs' ? 11 : size === 'sm' ? 12 : 13)
</script>

<button
  type="button"
  class="inline-flex shrink-0 items-center gap-1.5 border font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-40 {sizeClass} {variantClass} {className}"
  {disabled}
  {onclick}
  title={title ?? label}
  aria-label={title ?? label}
>
  {#if icon}
    {@const Icon = icon}
    <Icon size={iconSize} class="shrink-0" />
  {/if}
  {#if loading}
    <span class="h-3 w-3 shrink-0 animate-spin border border-current border-t-transparent"></span>
  {/if}
  <span class="min-w-0 truncate">{label}</span>
</button>
