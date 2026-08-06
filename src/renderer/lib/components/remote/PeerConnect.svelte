<script lang="ts">
  import { Eye, EyeOff, Loader2, Plug, Unplug } from '@lucide/svelte'

  interface Props {
    secret?: string
    connected: boolean
    busy: boolean
    onConnect: (secret: string) => void
    onDisconnect: () => void
  }

  let { secret = $bindable(''), connected, busy, onConnect, onDisconnect }: Props = $props()

  let showSecret = $state(false)
  let hasTouched = $state(false)
  let invalid = $derived(hasTouched && secret.trim().length === 0)
</script>

<section class="rounded-xl border bg-surface p-4" aria-label="Connect to the desktop">
  <div class="flex items-center gap-2.5">
    <h2 class="text-sm font-semibold text-foreground">Connect to your desktop</h2>
    {#if connected}
      <span class="rounded-md bg-info/10 px-1.5 py-0.5 text-[10px] font-medium text-info"
        >Connected</span
      >
    {/if}
  </div>

  <form
    class="mt-3 space-y-3"
    onsubmit={(event: SubmitEvent) => {
      event.preventDefault()
      hasTouched = true
      if (secret.trim().length > 0) onConnect(secret.trim())
    }}
  >
    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for="remote-peer-secret"
        >Peer secret</label
      >
      <div class="relative">
        <input
          id="remote-peer-secret"
          type={showSecret ? 'text' : 'password'}
          class="w-full rounded-lg border bg-elevated px-3 py-2 pr-10 text-sm text-foreground placeholder:text-dimmed"
          placeholder="PEER_SECRET_AUTH"
          autocomplete="off"
          spellcheck="false"
          bind:value={secret}
          oninput={() => (hasTouched = true)}
          aria-invalid={invalid}
          aria-describedby="remote-peer-secret-hint"
        />
        <button
          type="button"
          class="absolute top-1/2 right-2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
          aria-label={showSecret ? 'Hide peer secret' : 'Show peer secret'}
          title={showSecret ? 'Hide peer secret' : 'Show peer secret'}
          onclick={() => (showSecret = !showSecret)}
        >
          {#if showSecret}
            <EyeOff size={14} />
          {:else}
            <Eye size={14} />
          {/if}
        </button>
      </div>
      <p id="remote-peer-secret-hint" class="mt-1 text-[11px] text-dimmed">
        The same PEER_SECRET_AUTH configured on your desktop.
      </p>
      {#if invalid}
        <p class="mt-1 text-[11px] text-danger">Enter the peer secret to connect.</p>
      {/if}
    </div>

    <div class="flex items-center gap-2">
      {#if connected}
        <button
          type="button"
          class="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
          aria-label="Disconnect from the desktop"
          title="Disconnect from the desktop"
          onclick={onDisconnect}
        >
          <Unplug size={15} />
          <span>Disconnect</span>
        </button>
      {:else}
        <button
          type="submit"
          class="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-on-primary transition-colors duration-150 hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-50"
          disabled={busy || secret.trim().length === 0}
          aria-label="Connect to the desktop"
          title="Connect to the desktop"
        >
          {#if busy}
            <Loader2 size={15} class="animate-spin" />
            <span>Connecting…</span>
          {:else}
            <Plug size={15} />
            <span>Connect</span>
          {/if}
        </button>
      {/if}
    </div>
  </form>
</section>
