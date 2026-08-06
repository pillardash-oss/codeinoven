<script lang="ts">
  import { toDataURL } from 'qrcode'
  import { Check, Copy, QrCode, Smartphone, Wifi } from '@lucide/svelte'

  interface Props {
    /** The full pairing URL to encode (includes the peer secret). */
    pairingUrl: string | null
    /** The bare PWA URL without the secret, shown as a manual fallback. */
    phoneUrl?: string | null
  }

  let { pairingUrl, phoneUrl = null }: Props = $props()

  let qrPromise = $derived(
    pairingUrl
      ? toDataURL(pairingUrl, {
          width: 224,
          margin: 1,
          errorCorrectionLevel: 'M',
          color: { dark: '#0f1720', light: '#ffffff' }
        })
      : null
  )
  let copied = $state(false)

  async function copyPairingUrl(): Promise<void> {
    if (!pairingUrl) return
    try {
      await navigator.clipboard.writeText(pairingUrl)
      copied = true
      setTimeout(() => (copied = false), 1500)
    } catch {
      // Clipboard may be unavailable; the URL is still visible.
    }
  }
</script>

<section class="rounded-xl border bg-surface p-5" aria-label="Scan to connect your phone">
  <div class="flex items-center gap-2">
    <Smartphone size={15} class="text-primary" />
    <h2 class="text-sm font-semibold text-foreground">Connect your phone</h2>
  </div>
  <p class="mt-1 text-xs leading-relaxed text-muted">
    Scan this code with your phone camera. The app opens on your phone already configured — no
    account, no typing, nothing to install manually.
  </p>

  {#if pairingUrl && qrPromise}
    <div class="mt-4 flex items-start gap-4">
      <div
        class="grid h-56 w-56 shrink-0 place-items-center rounded-xl border border-border bg-white p-2"
      >
        {#await qrPromise}
          <QrCode size={40} class="animate-pulse text-dimmed" />
        {:then url}
          <img src={url} alt="QR code to connect your phone" class="h-full w-full" />
        {:catch}
          <p class="px-3 text-center text-xs text-danger">Could not generate the QR code.</p>
        {/await}
      </div>

      <ol class="min-w-0 flex-1 space-y-3 text-xs">
        <li class="flex gap-2">
          <Wifi size={14} class="mt-0.5 shrink-0 text-muted" />
          <span class="leading-relaxed text-muted">
            <strong class="font-medium text-foreground">Same Wi-Fi.</strong> Connect your phone to the
            same network as this computer.
          </span>
        </li>
        <li class="flex gap-2">
          <Smartphone size={14} class="mt-0.5 shrink-0 text-muted" />
          <span class="leading-relaxed text-muted">
            <strong class="font-medium text-foreground">Scan.</strong> Open your camera and point it at
            this code.
          </span>
        </li>
        <li class="flex gap-2">
          <Check size={14} class="mt-0.5 shrink-0 text-muted" />
          <span class="leading-relaxed text-muted">
            <strong class="font-medium text-foreground">You are in.</strong> The phone connects to this
            desktop automatically and securely.
          </span>
        </li>
      </ol>
    </div>

    {#if phoneUrl}
      <p class="mt-3 text-[11px] text-dimmed">
        Camera not cooperating? Open this on your phone manually:
      </p>
      <div class="mt-1 flex items-center gap-2">
        <code
          class="min-w-0 flex-1 truncate rounded-md bg-elevated px-2 py-1 font-mono text-[11px] text-muted"
          title={phoneUrl}>{phoneUrl}</code
        >
        <button
          type="button"
          class="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
          aria-label="Copy the phone client address"
          title="Copy the phone client address"
          onclick={() => void copyPairingUrl()}
        >
          {#if copied}
            <Check size={12} class="text-primary" />
            <span>Copied</span>
          {:else}
            <Copy size={12} />
            <span>Copy</span>
          {/if}
        </button>
      </div>
    {/if}
  {:else}
    <p class="mt-3 rounded-lg bg-elevated px-3 py-2 text-xs text-dimmed">
      The connection server is starting… once it is ready the QR code will appear here.
    </p>
  {/if}
</section>
