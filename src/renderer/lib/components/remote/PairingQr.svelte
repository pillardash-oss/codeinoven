<script lang="ts">
  import { onMount } from 'svelte'
  import { Check, Copy, QrCode, ShieldCheck, Smartphone, Timer, Wifi } from '@lucide/svelte'
  import { copyText } from '$lib/copy-text'

  interface Props {
    /** The full pairing URL to encode (includes the pairing bootstrap). */
    pairingUrl: string | null
    /** The bare PWA URL without the secret, shown as a manual fallback. */
    phoneUrl?: string | null
    /** Epoch ms when the pairing code stops being valid (five-minute window). */
    pairingExpiresAt?: number | null
    /** The LAN interface the gateway is advertising, e.g. `192.168.0.166`. */
    networkInterface?: string | null
  }

  let {
    pairingUrl,
    phoneUrl = null,
    pairingExpiresAt = null,
    networkInterface = null
  }: Props = $props()

  // The QR code only ever renders on the desktop (the PWA never shows it), so
  // the `qrcode` package is imported lazily — Vite splits it into a separate
  // chunk the phone never downloads. Keep this out of the PWA bundle.
  let qrPromise = $derived.by(async (): Promise<string | null> => {
    if (!pairingUrl) return null
    try {
      const { toDataURL } = await import('qrcode')
      return toDataURL(pairingUrl, {
        width: 224,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#0f1720', light: '#ffffff' }
      })
    } catch {
      return null
    }
  })
  let copied = $state(false)

  // Live pairing countdown so the human can see the code expiring.
  let now = $state(Date.now())
  onMount(() => {
    if (pairingExpiresAt === null || pairingExpiresAt === undefined) return
    const timer = setInterval(() => {
      now = Date.now()
    }, 1_000)
    return () => clearInterval(timer)
  })
  let remainingMs = $derived(
    pairingExpiresAt !== null && pairingExpiresAt !== undefined
      ? Math.max(0, pairingExpiresAt - now)
      : null
  )
  let pairingExpired = $derived(remainingMs !== null && remainingMs <= 0)
  let pairingLabel = $derived.by(() => {
    if (remainingMs === null) return 'This code stays valid while this screen is open'
    if (pairingExpired) return 'This pairing code has expired. Refresh it to scan again.'
    const seconds = Math.ceil(remainingMs / 1_000)
    if (seconds < 60) return `This code expires in ${seconds}s`
    return `This code expires in ${Math.ceil(seconds / 60)}m ${seconds % 60}s`
  })

  async function copyPairingUrl(): Promise<void> {
    if (!pairingUrl) return
    try {
      await copyText(pairingUrl)
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

  {#if pairingExpiresAt !== null && pairingExpiresAt !== undefined}
    <p
      class="mt-3 flex items-center gap-1.5 rounded-lg bg-elevated px-2.5 py-1.5 text-[11px] {pairingExpired
        ? 'text-danger'
        : 'text-muted'}"
      role="status"
    >
      <Timer size={12} class="shrink-0" />
      <span>{pairingLabel}</span>
    </p>
  {/if}

  {#if pairingUrl}
    <div class="mt-4 flex items-start gap-4">
      <div
        class="grid h-56 w-56 shrink-0 place-items-center rounded-xl border border-border bg-white p-2"
      >
        {#await qrPromise}
          <QrCode size={40} class="animate-pulse text-dimmed" />
        {:then url}
          {#if url}
            <img src={url} alt="QR code to connect your phone" class="h-full w-full" />
          {:else}
            <p class="px-3 text-center text-xs text-danger">Could not generate the QR code.</p>
          {/if}
        {:catch}
          <p class="px-3 text-center text-xs text-danger">Could not generate the QR code.</p>
        {/await}
      </div>

      <ol class="min-w-0 flex-1 space-y-3 text-xs">
        <li class="flex gap-2">
          <Wifi size={14} class="mt-0.5 shrink-0 text-muted" />
          <span class="leading-relaxed text-muted">
            <strong class="font-medium text-foreground">Same Wi-Fi.</strong> Connect your phone to
            the same network as this computer.
            {#if networkInterface}
              <span class="mt-0.5 block text-[11px] text-dimmed"
                >This computer is on {networkInterface}.</span
              >
            {/if}
          </span>
        </li>
        <li class="flex gap-2">
          <Smartphone size={14} class="mt-0.5 shrink-0 text-muted" />
          <span class="leading-relaxed text-muted">
            <strong class="font-medium text-foreground">Scan.</strong> Open your camera and point it at
            this code within the five-minute window.
          </span>
        </li>
        <li class="flex gap-2">
          <ShieldCheck size={14} class="mt-0.5 shrink-0 text-muted" />
          <span class="leading-relaxed text-muted">
            <strong class="font-medium text-foreground">You are in.</strong> This phone gets its own scoped
            credential you can revoke anytime — one scan, secure from then on.
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
          class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11px] text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
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
