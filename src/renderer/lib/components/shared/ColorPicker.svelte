<script lang="ts">
  /**
   * A colour picker built only from controls the native dock can carry.
   *
   * It used to be drawn on two canvases. A canvas cannot be projected into the
   * native dock, so promoting the host dialog to native left the picker either
   * invisible or hidden behind the native view. Hue, saturation and brightness are
   * plain range inputs instead: the dock already carries an input's value in both
   * directions, so dragging a slider in the native window reaches exactly the same
   * handler a drag in the app window reaches.
   */
  import { PROJECT_COLORS } from '$lib/project-colors'
  import { X } from '@lucide/svelte'

  interface Props {
    value?: string
    oncolorchange?: (color: string) => void
    onclose?: () => void
  }

  let { value = '#6366f1', oncolorchange = () => {}, onclose = () => {} }: Props = $props()

  function hexFromHsv(h: number, s: number, v: number): string {
    const index = Math.floor(h / 60)
    const fraction = h / 60 - index
    const low = v * (1 - s)
    const falling = v * (1 - fraction * s)
    const rising = v * (1 - (1 - fraction) * s)
    const channels: [number, number, number] =
      index % 6 === 0
        ? [v, rising, low]
        : index % 6 === 1
          ? [falling, v, low]
          : index % 6 === 2
            ? [low, v, rising]
            : index % 6 === 3
              ? [low, falling, v]
              : index % 6 === 4
                ? [rising, low, v]
                : [v, low, falling]
    return `#${channels
      .map((channel) =>
        Math.round(channel * 255)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')}`
  }

  function hsvFromHex(hex: string): { h: number; s: number; v: number } {
    const parsed = hex.replace('#', '').match(/^([0-9a-fA-F]{6})$/)
    if (!parsed) return { h: 0, s: 0, v: 1 }
    const [r, g, b] = [0, 2, 4].map(
      (offset) => Number.parseInt(parsed[1].slice(offset, offset + 2), 16) / 255
    )
    const highest = Math.max(r, g, b)
    const lowest = Math.min(r, g, b)
    const span = highest - lowest
    const saturation = highest === 0 ? 0 : span / highest
    let hue = 0
    if (span !== 0) {
      if (highest === r) hue = ((g - b) / span + (g < b ? 6 : 0)) * 60
      else if (highest === g) hue = ((b - r) / span + 2) * 60
      else hue = ((r - g) / span + 4) * 60
    }
    return { h: hue, s: saturation, v: highest }
  }

  // Null until the user takes over. Until then the sliders follow the `value`
  // prop, so the picker agrees with whatever opened it, and after the first
  // interaction the user's own numbers win.
  let hue = $state<number | null>(null)
  let saturation = $state<number | null>(null)
  let brightness = $state<number | null>(null)
  // Null unless the field is focused: while editing, the typed text is the truth;
  // otherwise the field mirrors the live colour so everything on screen agrees.
  let hexDraft = $state<string | null>(null)

  const seeded = $derived(hsvFromHex(value))
  // Hue, saturation and brightness are kept unrounded so a colour that arrived
  // exactly (from the system panel, the hex field, or the value prop) round-trips
  // back to the same bytes. Only the sliders' own readings are whole numbers.
  const chosen = $derived({
    h: hue ?? seeded.h,
    s: saturation ?? seeded.s * 100,
    v: brightness ?? seeded.v * 100
  })

  const current = $derived(hexFromHsv(chosen.h, chosen.s / 100, chosen.v / 100).toLowerCase())
  const pureHue = $derived(hexFromHsv(chosen.h, 1, 1).toLowerCase())
  const hexText = $derived(hexDraft ?? current.toUpperCase())

  function emit(): void {
    oncolorchange(current)
  }

  function readRange(event: Event): number {
    const input = event.currentTarget
    return input instanceof HTMLInputElement ? Number(input.value) : 0
  }

  function takeOver(h: number, s: number, v: number): void {
    hue = h
    saturation = s
    brightness = v
  }

  function typedHex(event: Event): void {
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement)) return
    const raw = input.value.trim()
    hexDraft = raw
    const candidate = raw.startsWith('#') ? raw : `#${raw}`
    if (!/^#[0-9a-fA-F]{6}$/.test(candidate)) return
    const picked = hsvFromHex(candidate)
    takeOver(picked.h, picked.s * 100, picked.v * 100)
    hexDraft = candidate
    emit()
  }

  function adoptPreset(color: string): void {
    const picked = hsvFromHex(color)
    takeOver(picked.h, picked.s * 100, picked.v * 100)
    hexDraft = null
    emit()
  }

  /**
   * The colour the system panel returned. Clicking the well opens the OS colour
   * picker, so this handler is also what runs when the user chooses there.
   */
  function adoptSystem(event: Event): void {
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement)) return
    if (!/^#[0-9a-fA-F]{6}$/.test(input.value)) return
    adoptPreset(input.value)
  }

  const sliders = $derived([
    {
      key: 'hue',
      label: 'Hue',
      min: 0,
      max: 360,
      step: 1,
      reading: Math.round(chosen.h),
      color: pureHue
    },
    {
      key: 'saturation',
      label: 'Saturation',
      min: 0,
      max: 100,
      step: 1,
      reading: Math.round(chosen.s),
      color: hexFromHsv(chosen.h, chosen.s / 100, 1).toLowerCase()
    },
    {
      key: 'brightness',
      label: 'Brightness',
      min: 0,
      max: 100,
      step: 1,
      reading: Math.round(chosen.v),
      color: current
    }
  ] as const)

  function applySlider(key: 'hue' | 'saturation' | 'brightness', next: number): void {
    takeOver(
      key === 'hue' ? next : chosen.h,
      key === 'saturation' ? next : chosen.s,
      key === 'brightness' ? next : chosen.v
    )
    hexDraft = null
    emit()
  }
</script>

<div class="flex flex-col gap-3">
  <div class="flex items-center justify-between">
    <span class="text-xs font-medium text-muted">Custom colour</span>
    <button
      type="button"
      class="flex h-6 w-6 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Close colour picker"
      title="Close"
      onclick={onclose}
    >
      <X size={14} />
    </button>
  </div>

  <div class="flex items-center gap-2">
    <input
      type="color"
      class="h-8 w-8 shrink-0 cursor-pointer appearance-none rounded-lg border bg-transparent p-0"
      style="background-color: {current}"
      value={current}
      aria-label="System colour picker"
      title="System colour picker"
      oninput={adoptSystem}
    />
    <input
      type="text"
      value={hexText}
      maxlength={7}
      spellcheck="false"
      autocomplete="off"
      class="w-full rounded-md border bg-elevated px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-foreground"
      aria-label="Hex colour"
      title="Hex colour"
      onfocus={() => (hexDraft = current.toUpperCase())}
      onblur={() => (hexDraft = null)}
      oninput={typedHex}
    />
  </div>

  {#each sliders as slider (slider.key)}
    <label class="flex flex-col gap-1">
      <span class="text-xs leading-relaxed text-muted">{slider.label}</span>
      <input
        type="range"
        min={slider.min}
        max={slider.max}
        step={slider.step}
        value={slider.reading}
        style="accent-color: {slider.color}"
        aria-label={slider.label}
        title={slider.label}
        oninput={(event) => applySlider(slider.key, readRange(event))}
      />
    </label>
  {/each}

  <div class="flex flex-wrap gap-1">
    {#each PROJECT_COLORS as option (option.value)}
      <button
        type="button"
        class="h-5 w-5 rounded-full border-2 transition-transform hover:scale-110 {option.value ===
        current
          ? 'border-foreground'
          : 'border-transparent'}"
        style="background-color: {option.value}"
        title={option.name}
        aria-label={option.name}
        aria-pressed={option.value === current}
        onclick={() => adoptPreset(option.value)}
      ></button>
    {/each}
  </div>
</div>
