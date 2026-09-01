<script lang="ts">
  import { FolderOpen, X } from '@lucide/svelte'
  import { PROJECT_COLORS } from '$lib/project-colors'
  import {
    PROJECT_SVG_ICONS,
    generateInitialsIconSvg,
    getIconSvgDataUrl
  } from '$lib/project-svg-icons'
  import ColorSwatches from './ColorSwatches.svelte'

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
</script>

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
    <ColorSwatches
      value={color ?? null}
      allowNone={false}
      oncolorchange={(next) => onColorChange(next ?? undefined)}
      suppressKey="appearance-color-picker"
    />
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
