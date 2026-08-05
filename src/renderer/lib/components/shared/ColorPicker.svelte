<script lang="ts">
  import { PROJECT_COLORS } from '$lib/project-colors'
  import { X } from '@lucide/svelte'

  interface Props {
    value?: string
    oncolorchange?: (color: string) => void
    onclose?: () => void
  }

  let { value = '#6366f1', oncolorchange = () => {}, onclose = () => {} }: Props = $props()

  let hue = $state(0)
  let sat = $state(1)
  let val = $state(1)
  let hexInput = $state('')
  let hexFocused = $state(false)

  let svCanvas = $state<HTMLCanvasElement>()
  let hueCanvas = $state<HTMLCanvasElement>()
  let draggingSV = $state(false)
  let draggingHue = $state(false)

  function hsvToHex(h: number, s: number, v: number): string {
    const i = Math.floor(h / 60)
    const f = h / 60 - i
    const p = v * (1 - s)
    const q = v * (1 - f * s)
    const t = v * (1 - (1 - f) * s)
    let r: number, g: number, b: number
    switch (i % 6) {
      case 0:
        ;[r, g, b] = [v, t, p]
        break
      case 1:
        ;[r, g, b] = [q, v, p]
        break
      case 2:
        ;[r, g, b] = [p, v, t]
        break
      case 3:
        ;[r, g, b] = [p, q, v]
        break
      case 4:
        ;[r, g, b] = [t, p, v]
        break
      case 5:
        ;[r, g, b] = [v, p, q]
        break
      default:
        ;[r, g, b] = [0, 0, 0]
    }
    const toHex = (n: number) =>
      Math.round(n * 255)
        .toString(16)
        .padStart(2, '0')
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
  }

  function hexToHsv(hex: string): { h: number; s: number; v: number } | null {
    const m = hex.replace('#', '').match(/^([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/)
    if (!m) return null
    const r = parseInt(m[1], 16) / 255
    const g = parseInt(m[2], 16) / 255
    const b = parseInt(m[3], 16) / 255
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const d = mx - mn
    let h = 0
    const s = mx === 0 ? 0 : d / mx
    const v = mx
    if (d !== 0) {
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
      else if (mx === g) h = ((b - r) / d + 2) * 60
      else h = ((r - g) / d + 4) * 60
    }
    return { h, s, v }
  }

  function emitColor() {
    const hex = hsvToHex(hue, sat, val)
    oncolorchange(hex)
  }

  function pickFromHex(hex: string) {
    const hsv = hexToHsv(hex)
    if (hsv) {
      hue = hsv.h
      sat = hsv.s
      val = hsv.v
      emitColor()
    }
  }

  function handleHexInput() {
    let raw = hexInput.trim()
    if (!raw.startsWith('#')) raw = '#' + raw
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
      pickFromHex(raw)
    }
  }

  function handleHexBlur() {
    hexFocused = false
    hexInput = value
  }

  function handleHexFocus() {
    hexFocused = true
    hexInput = value
  }

  $effect(() => {
    if (!hexFocused) {
      hexInput = value
    }
  })

  $effect(() => {
    if (svCanvas) drawSvField()
  })

  $effect(() => {
    if (hueCanvas) drawHueBar()
  })

  function drawSvField() {
    const ctx = svCanvas!.getContext('2d')!
    const w = svCanvas!.width
    const h = svCanvas!.height

    const hueColor = hsvToHex(hue, 1, 1)

    const whiteGrad = ctx.createLinearGradient(0, 0, w, 0)
    whiteGrad.addColorStop(0, '#ffffff')
    whiteGrad.addColorStop(1, hueColor)
    ctx.fillStyle = whiteGrad
    ctx.fillRect(0, 0, w, h)

    const blackGrad = ctx.createLinearGradient(0, 0, 0, h)
    blackGrad.addColorStop(0, 'transparent')
    blackGrad.addColorStop(1, '#000000')
    ctx.fillStyle = blackGrad
    ctx.fillRect(0, 0, w, h)

    const sx = sat * w
    const sy = (1 - val) * h
    const indicatorColor = hsvToHex(hue, sat, val)
    const lum =
      0.299 * parseInt(indicatorColor.slice(1, 3), 16) +
      0.587 * parseInt(indicatorColor.slice(3, 5), 16) +
      0.114 * parseInt(indicatorColor.slice(5, 7), 16)

    ctx.beginPath()
    ctx.arc(sx, sy, 6, 0, Math.PI * 2)
    ctx.strokeStyle = lum > 150 ? '#000000' : '#ffffff'
    ctx.lineWidth = 2.5
    ctx.stroke()
  }

  function drawHueBar() {
    const ctx = hueCanvas!.getContext('2d')!
    const w = hueCanvas!.width
    const h = hueCanvas!.height

    const stops = ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000']
    const grad = ctx.createLinearGradient(0, 0, w, 0)
    stops.forEach((stop, i) => grad.addColorStop(i / (stops.length - 1), stop))
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)

    const hx = (hue / 360) * w
    ctx.beginPath()
    ctx.arc(hx, h / 2, 7, 0, Math.PI * 2)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2.5
    ctx.shadowColor = 'rgba(0,0,0,0.3)'
    ctx.shadowBlur = 3
    ctx.stroke()
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
  }

  function svPos(e: PointerEvent) {
    if (!svCanvas) return { x: 0, y: 0 }
    const r = svCanvas.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))
    }
  }

  function huePos(e: PointerEvent) {
    if (!hueCanvas) return 0
    const r = hueCanvas.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  }

  function onSvPointerDown(e: PointerEvent) {
    const p = svPos(e)
    sat = p.x
    val = 1 - p.y
    draggingSV = true
    svCanvas!.setPointerCapture(e.pointerId)
    emitColor()
  }

  function onSvPointerMove(e: PointerEvent) {
    if (!draggingSV) return
    const p = svPos(e)
    sat = p.x
    val = 1 - p.y
    emitColor()
  }

  function onSvPointerUp() {
    draggingSV = false
  }

  function onHuePointerDown(e: PointerEvent) {
    const p = huePos(e)
    hue = p * 360
    draggingHue = true
    hueCanvas!.setPointerCapture(e.pointerId)
    emitColor()
  }

  function onHuePointerMove(e: PointerEvent) {
    if (!draggingHue) return
    const p = huePos(e)
    hue = p * 360
    emitColor()
  }

  function onHuePointerUp() {
    draggingHue = false
  }

  function close() {
    onclose()
  }

  function handleSwatchClick(c: string) {
    pickFromHex(c)
  }
</script>

<div class="flex flex-col gap-3">
  <div class="flex items-center justify-between">
    <span class="text-xs font-medium text-muted">Custom Colour</span>
    <button
      type="button"
      class="flex h-5 w-5 items-center justify-center rounded text-muted transition-colors hover:text-foreground"
      aria-label="Close colour picker"
      title="Close"
      onclick={close}
    >
      <X size={14} />
    </button>
  </div>

  <div class="relative select-none">
    <canvas
      bind:this={svCanvas}
      width={220}
      height={160}
      class="w-full cursor-crosshair rounded-lg"
      aria-label="Saturation and brightness"
      onpointerdown={onSvPointerDown}
      onpointermove={onSvPointerMove}
      onpointerup={onSvPointerUp}
      onpointerleave={onSvPointerUp}
    ></canvas>
  </div>

  <div
    class="relative select-none"
    role="slider"
    aria-label="Hue"
    aria-valuemin="0"
    aria-valuemax="360"
    aria-valuenow={Math.round(hue)}
  >
    <canvas
      bind:this={hueCanvas}
      width={220}
      height={14}
      class="w-full cursor-pointer rounded-md"
      onpointerdown={onHuePointerDown}
      onpointermove={onHuePointerMove}
      onpointerup={onHuePointerUp}
      onpointerleave={onHuePointerUp}
    ></canvas>
  </div>

  <div class="flex items-center gap-2">
    <div
      class="h-7 w-7 flex-shrink-0 rounded-md border"
      style="background-color: {value}"
      title="Current colour"
    ></div>
    <div class="relative flex-1">
      {#if hexFocused}
        <input
          type="text"
          bind:value={hexInput}
          maxlength={7}
          class="w-full rounded-md border bg-elevated px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-foreground"
          oninput={handleHexInput}
          onblur={handleHexBlur}
        />
      {:else}
        <button
          type="button"
          class="w-full rounded-md border bg-elevated px-2 py-1 text-left font-mono text-xs text-foreground transition-colors hover:bg-raised"
          onclick={handleHexFocus}
        >
          {value}
        </button>
      {/if}
    </div>
  </div>

  <div class="flex flex-wrap gap-1">
    {#each PROJECT_COLORS as option (option.value)}
      <button
        type="button"
        class="h-5 w-5 rounded-full border-2 transition-transform hover:scale-110 {option.value ===
        value
          ? 'border-foreground'
          : 'border-transparent'}"
        style="background-color: {option.value}"
        title={option.name}
        aria-label={option.name}
        onclick={() => handleSwatchClick(option.value)}
      ></button>
    {/each}
  </div>
</div>
