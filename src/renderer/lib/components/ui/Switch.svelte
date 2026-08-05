<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    checked: boolean
    onchange?: (checked: boolean) => void
    disabled?: boolean
    /** Optional text rendered after the toggle. Prefer `children` for richer rows. */
    label?: string
    /** Custom tooltip text (handled by the global tooltip system). */
    title?: string
    role?: string
    class?: string
    /** Track colour when checked. Defaults to the primary brand colour. */
    activeClass?: string
    'aria-label'?: string
    'aria-describedby'?: string
    /** Optional row content rendered after the toggle; receives the current state. */
    children?: Snippet<[boolean]>
  }

  let {
    checked = $bindable(false),
    onchange,
    disabled = false,
    label,
    title,
    role = 'switch',
    class: className = '',
    activeClass = 'bg-primary',
    'aria-label': ariaLabel,
    'aria-describedby': ariaDescribedBy,
    children
  }: Props = $props()

  function toggle(): void {
    if (disabled) return
    if (onchange) {
      onchange(!checked)
    } else {
      checked = !checked
    }
  }
</script>

<button
  type="button"
  {role}
  aria-checked={checked}
  {disabled}
  {title}
  aria-label={ariaLabel}
  aria-describedby={ariaDescribedBy}
  class="flex shrink-0 items-center gap-2 text-left text-xs disabled:opacity-50 {className}"
  onclick={toggle}
>
  <span
    class="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors {checked
      ? activeClass
      : 'bg-overlay'}"
  >
    <span
      class="inline-block h-3 w-3 rounded-full bg-surface transition-transform {checked
        ? 'translate-x-3.5'
        : 'translate-x-0.5'}"
    ></span>
  </span>
  {#if children}
    {@render children(checked)}
  {:else if label}
    <span>{label}</span>
  {/if}
</button>
