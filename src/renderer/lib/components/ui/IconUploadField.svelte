<script lang="ts">
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'

  /**
   * One uploaded image, for any surface that stamps artwork on a record.
   *
   * The custom base-URL vendor editor and the ACP agent editor both need exactly
   * this control: a square preview, a file picker, the same validation, and an
   * optional clear. It lives here rather than in either editor so a third
   * surface can have it without copying the rules.
   */
  interface Props {
    /** Field label, e.g. "Vendor icon" or "Light mode". */
    label: string
    /** Accepted image mime types. */
    accept: readonly string[]
    /** Largest file the field will read. */
    maxBytes: number
    /** Current image as a data URL. */
    value?: string | undefined
    /** Whether the field is busy disabling uploads (a save in flight, say). */
    disabled?: boolean
    /** Fallback name for the placeholder mark while no image is chosen. */
    name?: string
    /** One line under the picker explaining the accepted artwork. */
    hint?: string
    /** Called with the data URL once a file was read and validated. */
    onselect: (dataUrl: string) => void
    /** When provided, a Clear control appears for a chosen image. */
    onclear?: () => void
    /** Owner-side reading state, so the picker reports its own work. */
    onreading?: (reading: boolean) => void
  }

  let {
    label,
    accept,
    maxBytes,
    value,
    disabled = false,
    name = 'CodeInOven',
    hint = 'SVG or image, up to 256 KiB.',
    onselect,
    onclear,
    onreading
  }: Props = $props()

  const MAX_EDGE = 2048
  /** Recomputed from the prop, so a different cap never reports the wrong size. */
  const sizeKb = $derived(Math.round(maxBytes / 1024))

  let reading = $state(false)
  let busy = $derived(disabled || reading)

  async function choose(event: Event): Promise<void> {
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement)) return
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    reading = true
    onreading?.(true)
    try {
      if (!accept.some((type) => type === file.type) || file.size > maxBytes) {
        throw new Error(`Choose one of ${accept.join(', ')} of at most ${sizeKb} KiB.`)
      }
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () =>
          typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(new Error('Cannot read image.'))
        reader.onerror = () => reject(new Error('Cannot read image.'))
        reader.readAsDataURL(file)
      })
      const image = new Image()
      image.src = data
      await image.decode()
      if (image.naturalWidth > MAX_EDGE || image.naturalHeight > MAX_EDGE) {
        throw new Error(`Choose an image no larger than ${MAX_EDGE} × ${MAX_EDGE}.`)
      }
      onselect(data)
    } catch (error) {
      reportError(error, `Failed to read the ${label.toLowerCase()} image.`)
    } finally {
      reading = false
      onreading?.(false)
    }
  }
</script>

<div
  class={[
    'flex items-center gap-3 border bg-surface p-3 transition-colors duration-150 focus-within:border-primary focus-within:bg-elevated',
    busy ? 'opacity-60' : 'hover:border-primary/40 hover:bg-elevated'
  ]}
>
  <span
    class="flex h-12 w-12 shrink-0 items-center justify-center border border-border bg-elevated"
  >
    <VendorIcon {name} imageSrc={value} size={value ? 40 : 32} />
  </span>
  <span class="min-w-0 flex-1 space-y-1 text-xs font-medium">
    <span class="flex items-center justify-between gap-2">
      <span>{label}</span>
      {#if value && onclear}
        <button
          type="button"
          class="px-1 text-[0.625rem] font-medium text-muted transition-colors hover:text-foreground"
          title={`Clear the ${label.toLowerCase()} image`}
          onclick={() => onclear?.()}
        >
          Clear
        </button>
      {/if}
    </span>
    <input
      type="file"
      accept={accept.join(',')}
      class="block w-full cursor-pointer text-xs text-dimmed file:cursor-pointer disabled:cursor-default disabled:file:cursor-default"
      disabled={busy}
      onchange={(event) => void choose(event)}
    />
    <span class="block text-dimmed">{hint}</span>
  </span>
</div>
