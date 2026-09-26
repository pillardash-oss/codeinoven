<script lang="ts">
  import { Code, FolderOpen, X } from '@lucide/svelte'
  import type { CustomIcon } from '$shared/types'
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
    customIcons?: CustomIcon[]
    allowCustomSvg?: boolean
    resetPlacement?: 'picker' | 'footer'
    fallbackIconUrl?: string | null
    onColorChange: (color: string | undefined) => void
    onIconTypeChange: (iconType: string | undefined) => void
    onCustomSvgChange?: (svg: string | undefined) => void
    onAddCustomIcon?: (name: string, svg: string) => Promise<void>
    onUploadImage?: () => void
    onReset: () => void
  }

  let {
    name,
    color,
    iconType,
    customSvg,
    customIcons = [],
    allowCustomSvg = false,
    resetPlacement = 'picker',
    fallbackIconUrl = null,
    onColorChange,
    onIconTypeChange,
    onCustomSvgChange,
    onAddCustomIcon,
    onUploadImage,
    onReset
  }: Props = $props()

  let previewColor = $derived(color ?? PROJECT_COLORS[0].value)
  let hasAppearance = $derived(Boolean(color || iconType || customSvg || fallbackIconUrl))
  let pastedSvg = $state('')
  let customSvgError = $state<string | null>(null)
  let showSvgInput = $state(false)
  let customIconName = $state('')
  let saveIconError = $state<string | null>(null)

  function applyCustomSvg(): void {
    try {
      const normalized = sanitizeCustomSvg(pastedSvg)
      onCustomSvgChange?.(normalized)
      onIconTypeChange(undefined)
      customSvgError = null
      showSvgInput = false
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
      {#each customIcons as customIcon (customIcon.id)}
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-md border transition-colors {customSvg ===
          customIcon.svg
            ? 'border-foreground bg-elevated'
            : 'border-border'}"
          title={customIcon.name}
          aria-label={customIcon.name}
          aria-pressed={customSvg === customIcon.svg}
          onclick={() => {
            onCustomSvgChange?.(customIcon.svg)
            onIconTypeChange(undefined)
          }}
        >
          <img
            src={getCustomSvgDataUrl(customIcon.svg, previewColor)}
            alt=""
            class="h-4 w-4 object-contain"
            draggable="false"
          />
        </button>
      {/each}
    </div>
  </div>

  {#if allowCustomSvg}
    <div class="flex gap-2">
      {#if onUploadImage}
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Upload a custom image icon"
          onclick={onUploadImage}
        >
          <FolderOpen size={12} />
          Upload image
        </button>
      {/if}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title={showSvgInput ? 'Hide custom SVG input' : 'Add a custom SVG icon'}
        aria-expanded={showSvgInput}
        aria-controls="appearance-custom-svg-panel"
        onclick={() => {
          showSvgInput = !showSvgInput
          if (showSvgInput && customSvg) pastedSvg = customSvg
        }}
      >
        <Code size={12} />
        {showSvgInput ? 'Hide SVG' : customSvg ? 'Edit SVG' : 'Add SVG'}
      </button>
    </div>
    {#if showSvgInput}
      <div id="appearance-custom-svg-panel" class="space-y-2">
        <label class="block text-xs font-medium text-muted" for="appearance-custom-svg"
          >Paste SVG</label
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
        {#if saveIconError}<p class="text-xs text-danger" role="alert">{saveIconError}</p>{/if}
        <div class="flex items-center justify-between gap-2">
          {#if onAddCustomIcon}
            <input
              class="min-w-0 flex-1 rounded-lg border bg-elevated px-3 py-1.5 text-xs text-foreground"
              bind:value={customIconName}
              placeholder="Name this icon"
              aria-label="Custom icon name"
            />
          {:else}<span></span>{/if}
          {#if onAddCustomIcon}
            <button
              type="button"
              class="rounded-lg border px-2.5 py-1.5 text-xs text-muted hover:bg-elevated hover:text-foreground"
              title="Save SVG to the shared icon library"
              onclick={async () => {
                try {
                  if (!customIconName.trim()) throw new Error('Enter a name for this icon')
                  const normalized = sanitizeCustomSvg(pastedSvg)
                  await onAddCustomIcon?.(customIconName, normalized)
                  onCustomSvgChange?.(normalized)
                  onIconTypeChange(undefined)
                  customIconName = ''
                  customSvgError = null
                  saveIconError = null
                  showSvgInput = false
                } catch (error) {
                  saveIconError = error instanceof Error ? error.message : 'Could not save icon'
                }
              }}>Save to library</button
            >
          {:else}
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
              title="Apply pasted SVG icon"
              onclick={applyCustomSvg}>Use SVG</button
            >
          {/if}
        </div>
      </div>
    {/if}
  {/if}

  {#if hasAppearance && resetPlacement === 'picker'}
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
