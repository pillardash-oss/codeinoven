<script lang="ts">
  import { FolderOpen, X, Palette } from '@lucide/svelte'
  import { PROJECT_COLORS } from '$lib/project-colors'
  import {
    PROJECT_SVG_ICONS,
    generateInitialsIconSvg,
    getIconSvgDataUrl
  } from '$lib/project-svg-icons'
  import ColorPicker from './ColorPicker.svelte'

  interface Props {
    name: string
    color?: string
    iconType?: string
    fallbackIconUrl?: string | null
    onColorChange: (color: string | undefined) => void
    onIconTypeChange: (iconType: string | undefined) => void
    onReset: () => void
  }

  let {
    name,
    color,
    iconType,
    fallbackIconUrl = null,
    onColorChange,
    onIconTypeChange,
    onReset
  }: Props = $props()

  let previewColor = $derived(color ?? PROJECT_COLORS[0].value)
  let hasAppearance = $derived(Boolean(color || iconType || fallbackIconUrl))

  let isCustomColor = $derived(Boolean(color && !PROJECT_COLORS.some((c) => c.value === color)))

  let showColorPicker = $state(false)

  function handleCustomColorClick() {
    showColorPicker = true
  }

  function handleColorPickerChange(newColor: string) {
    onColorChange(newColor)
  }

  function handleColorPickerClose() {
    showColorPicker = false
  }
</script>

<svelte:window
  onkeydown={(e: KeyboardEvent) => {
    if (e.key === 'Escape' && showColorPicker) showColorPicker = false
  }}
/>

<div class="space-y-4">
  <div class="flex justify-center">
    <div
      class="flex h-14 w-14 items-center justify-center rounded-xl border-2 border-dashed"
      style={color ? `background-color: ${color}20` : ''}
      title="Icon preview"
    >
      {#if fallbackIconUrl}
        <img src={fallbackIconUrl} alt="" class="h-8 w-8 object-contain" draggable="false" />
      {:else if iconType}
        <img
          src={getIconSvgDataUrl(iconType, previewColor)}
          alt=""
          class="h-8 w-8 object-contain"
          draggable="false"
        />
      {:else if color}
        <img
          src={generateInitialsIconSvg(name, color)}
          alt=""
          class="h-8 w-8 object-contain"
          draggable="false"
        />
      {:else}
        <FolderOpen size={22} class="text-muted" />
      {/if}
    </div>
  </div>

  <div>
    <span class="mb-1 block text-xs font-medium text-muted">Colour</span>
    <div class="flex flex-wrap gap-1.5">
      {#each PROJECT_COLORS as option (option.value)}
        <button
          type="button"
          class="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 {color ===
          option.value
            ? 'border-foreground'
            : 'border-transparent'}"
          style="background-color: {option.value}; {color === option.value
            ? `box-shadow: 0 0 0 1px ${option.value}`
            : ''}"
          title={option.name}
          aria-label={option.name}
          aria-pressed={color === option.value}
          onclick={() => onColorChange(color === option.value ? undefined : option.value)}
        ></button>
      {/each}
      <button
        type="button"
        class="relative flex h-6 w-6 items-center justify-center rounded-full border-2 transition-transform hover:scale-110 {isCustomColor
          ? 'border-foreground'
          : 'border-dashed border-muted'}"
        style={isCustomColor ? `background-color: ${color}; box-shadow: 0 0 0 1px ${color}` : ''}
        title="Custom colour"
        aria-label="Custom colour"
        aria-pressed={isCustomColor}
        onclick={handleCustomColorClick}
      >
        <Palette size={10} class="text-muted {isCustomColor ? 'opacity-0' : ''}" />
      </button>
    </div>
  </div>

  <div>
    <span class="mb-1 block text-xs font-medium text-muted">Icon</span>
    <div class="flex flex-wrap gap-1.5">
      {#each PROJECT_SVG_ICONS as icon (icon.key)}
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-md border transition-colors {iconType ===
          icon.key
            ? 'border-foreground bg-elevated'
            : 'border-border'}"
          title={icon.label}
          aria-label={icon.label}
          aria-pressed={iconType === icon.key}
          onclick={() => onIconTypeChange(iconType === icon.key ? undefined : icon.key)}
        >
          <img
            src={getIconSvgDataUrl(icon.key, previewColor)}
            alt=""
            class="h-4 w-4 object-contain"
            draggable="false"
          />
        </button>
      {/each}
    </div>
  </div>

  {#if hasAppearance}
    <div class="flex justify-end">
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10"
        title="Reset appearance"
        onclick={onReset}
      >
        <X size={12} />
        Reset
      </button>
    </div>
  {/if}
</div>

{#if showColorPicker}
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center"
    role="dialog"
    aria-modal="true"
    aria-label="Custom colour picker"
  >
    <button
      class="absolute inset-0 cursor-default"
      aria-label="Close colour picker"
      onclick={handleColorPickerClose}
    ></button>

    <div
      class="relative w-[260px] rounded-xl border bg-surface p-4 shadow-xl"
      onclick={(e: MouseEvent) => e.stopPropagation()}
      onkeydown={() => {}}
      role="presentation"
    >
      <ColorPicker
        value={color ?? PROJECT_COLORS[0].value}
        oncolorchange={handleColorPickerChange}
        onclose={handleColorPickerClose}
      />
    </div>
  </div>
{/if}
