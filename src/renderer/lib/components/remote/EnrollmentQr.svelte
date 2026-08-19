<script lang="ts">
  import { QrCode } from '@lucide/svelte'

  interface Props {
    value: string
  }

  let { value }: Props = $props()

  let qrPromise = $derived.by(async (): Promise<string | null> => {
    if (!value) return null
    try {
      const { toDataURL } = await import('qrcode')
      return toDataURL(value, {
        width: 176,
        margin: 2,
        errorCorrectionLevel: 'M'
      })
    } catch {
      return null
    }
  })
</script>

<div
  class="grid h-44 w-44 shrink-0 place-items-center overflow-hidden rounded-xl border bg-surface p-2"
>
  {#await qrPromise}
    <QrCode size={32} class="animate-pulse text-dimmed" />
  {:then url}
    {#if url}
      <img src={url} alt="QR code to open the mobile PWA" class="h-full w-full" />
    {:else}
      <p class="px-3 text-center text-xs text-danger">Could not generate the QR code.</p>
    {/if}
  {:catch}
    <p class="px-3 text-center text-xs text-danger">Could not generate the QR code.</p>
  {/await}
</div>
