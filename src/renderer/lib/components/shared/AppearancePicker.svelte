<script lang="ts">
  import { Check, FolderOpen, X } from '@lucide/svelte'
  import { PROJECT_COLORS } from '$lib/project-colors'
  import {
    PROJECT_SVG_ICONS,
    generateInitialsIconSvg,
    getIconSvgDataUrl
  } from '$lib/project-svg-icons'
  import ColorSwatches from './ColorSwatches.svelte'
  import { getCustomSvgDataUrl, sanitizeCustomSvg } from '../../../../lib/custom-svg'

  interface Props {
    name: string
    color?: string
    iconType?: string
    customSvg?: string
    allowCustomSvg?: boolean
    fallbackIconUrl?: string | null
    onColorChange: (color: string | undefined) => void
    onIconTypeChange: (iconType: string | undefined) => void
    onCustomSvgChange?: (svg: string | undefined) => void
    onReset: () => void
  }

  let {
    name,
    color,
    iconType,
    customSvg,
    allowCustomSvg = false,
    fallbackIconUrl = null,
    onColorChange,
    onIconTypeChange,
    onCustomSvgChange,
    onReset
  }: Props = $props()

  let previewColor = $derived(color ?? PROJECT_COLORS[0].value)
  let hasAppearance = $derived(Boolean(color || iconType || customSvg || fallbackIconUrl))
  let pastedSvg = $state('')
  let customSvgError = $state<string | null>(null)

  function applyCustomSvg(): void {
    try {
      const normalized = sanitizeCustomSvg(pastedSvg)
      onCustomSvgChange?.(normalized)
      onIconTypeChange(undefined)
      customSvgError = null
    } catch (error) {
      customSvgError = error instanceof Error ? error.message : 'Could not read this SVG'
    }
  }
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
      {:else if customSvg}
        <img
          src={getCustomSvgDataUrl(customSvg, previewColor)}
          alt=""
          class="h-8 w-8 object-contain"
          draggable="false"
        />
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
          onclick={() => {
            onIconTypeChange(iconType === icon.key ? undefined : icon.key)
            onCustomSvgChange?.(undefined)
          }}
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

  {#if allowCustomSvg}
    <div class="space-y-2">
      <label class="block text-xs font-medium text-muted" for="appearance-custom-svg"
        >Custom SVG</label
      >
      <textarea
        id="appearance-custom-svg"
        class="min-h-24 w-full resize-y rounded-lg border bg-elevated px-3 py-2 font-mono text-xs text-foreground placeholder:text-dimmed"
        bind:value={pastedSvg}
        placeholder="Paste SVG markup with a viewBox"
        aria-describedby={customSvgError ? 'appearance-custom-svg-error' : undefined}></textarea>
      {#if customSvgError}
        <p id="appearance-custom-svg-error" class="text-xs text-danger" role="alert">
          {customSvgError}
        </p>
      {/if}
      <div class="flex items-center justify-between gap-2">
        {#if customSvg}
          <button
            type="button"
            class="rounded-lg px-2 py-1 text-xs text-muted hover:bg-elevated"
            title="Remove custom SVG icon"
            aria-label="Remove custom SVG icon"
            onclick={() => onCustomSvgChange?.(undefined)}
          >
            <X size={12} />
          </button>
        {:else}<span></span>{/if}
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Apply pasted SVG icon"
          onclick={applyCustomSvg}
        >
          <Check size={12} />
          Use SVG
        </button>
      </div>
    </div>
  {/if}

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
