<script lang="ts">
  import { Check, Palette, X } from '@lucide/svelte'
  import { PROJECT_COLORS } from '$lib/project-colors'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import ColorPicker from './ColorPicker.svelte'

  interface Props {
    /** Currently selected colour (hex), or null for no colour. */
    value?: string | null
    /** Emitted whenever the selection changes; null clears the colour. */
    oncolorchange?: (color: string | null) => void
    /** Show the "No colour" swatch. Defaults to true. */
    allowNone?: boolean
    /** Swatch size: 'sm' (20px) or 'md' (24px). Defaults to 'md'. */
    size?: 'sm' | 'md'
    /** When set, opening the custom picker marks this key in the fullscreen
     *  surface store so native overlays stay suppressed (sidebar surfaces). */
    suppressKey?: string
  }

  let {
    value = null,
    oncolorchange = () => {},
    allowNone = true,
    size = 'md',
    suppressKey
  }: Props = $props()

  let showPicker = $state(false)
  let isCustomColor = $derived(
    Boolean(value && !PROJECT_COLORS.some((option) => option.value === value))
  )
  const swatchClass = $derived(size === 'sm' ? 'h-5 w-5' : 'h-6 w-6')

  $effect(() => {
    if (!suppressKey) return
    contextSidebarState.setFullscreenSurfaceActive(suppressKey, showPicker)
    return () => {
      contextSidebarState.setFullscreenSurfaceActive(suppressKey, false)
    }
  })

  const checkSize = $derived(size === 'sm' ? 8 : 10)
  const chipInner = $derived(size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5')
  const chipIcon = $derived(size === 'sm' ? 8 : 9)

  function select(optionValue: string): void {
    oncolorchange(value === optionValue ? null : optionValue)
  }
</script>

<svelte:window
  onkeydown={(event: KeyboardEvent) => {
    if (event.key === 'Escape' && showPicker) showPicker = false
  }}
/>

<div class="flex flex-wrap items-center gap-1.5">
  <!-- Live current-colour indicator so the selection is always obvious. -->
  <span
    class="flex {swatchClass} shrink-0 items-center justify-center rounded-full border-2 {value ===
    null
      ? 'border-border'
      : 'border-foreground'}"
    style="background-color: {value ?? 'transparent'}"
    title={value ?? 'No colour selected'}
    aria-hidden="true"
  >
    {#if value === null}
      <X size={chipIcon} class="text-muted" />
    {/if}
  </span>
  {#if allowNone}
    <button
      type="button"
      class="flex {swatchClass} items-center justify-center rounded-full border-2 transition-transform hover:scale-110 {value ===
      null
        ? 'border-foreground'
        : 'border-border'}"
      title="No colour"
      aria-label="No colour"
      aria-pressed={value === null}
      onclick={() => oncolorchange(null)}
    >
      <X size={size === 'sm' ? 11 : 12} class="text-muted" />
    </button>
  {/if}
  {#each PROJECT_COLORS as option (option.value)}
    <button
      type="button"
      class="relative {swatchClass} rounded-full border-2 transition-transform hover:scale-110 {value ===
      option.value
        ? 'border-foreground'
        : 'border-transparent'}"
      style="background-color: {option.value}"
      title={option.name}
      aria-label={option.name}
      aria-pressed={value === option.value}
      onclick={() => select(option.value)}
    >
      {#if value === option.value}
        <span
          class="absolute inset-0 m-auto flex {chipInner} items-center justify-center rounded-full bg-white/90 shadow-sm"
        >
          <Check size={checkSize} class="text-black/70" />
        </span>
      {/if}
    </button>
  {/each}
  <button
    type="button"
    class="relative flex {swatchClass} items-center justify-center rounded-full border-2 transition-transform hover:scale-110 {isCustomColor
      ? 'border-foreground'
      : 'border-dashed border-muted'}"
    style={isCustomColor ? `background-color: ${value}; box-shadow: 0 0 0 1px ${value}` : ''}
    title="Custom colour"
    aria-label="Custom colour"
    aria-pressed={isCustomColor}
    onclick={() => (showPicker = true)}
  >
    <Palette size={size === 'sm' ? 10 : 12} class="text-muted {isCustomColor ? 'opacity-0' : ''}" />
  </button>
</div>

{#if showPicker}
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center"
    role="dialog"
    aria-modal="true"
    aria-label="Custom colour picker"
  >
    <button
      class="absolute inset-0 cursor-default"
      aria-label="Close colour picker"
      onclick={() => (showPicker = false)}
    ></button>

    <div
      class="relative w-[260px] rounded-xl border bg-surface p-4 shadow-xl"
      role="presentation"
      onclick={(event: MouseEvent) => event.stopPropagation()}
    >
      <ColorPicker
        value={value ?? PROJECT_COLORS[0].value}
        {oncolorchange}
        onclose={() => (showPicker = false)}
      />
    </div>
  </div>
{/if}
