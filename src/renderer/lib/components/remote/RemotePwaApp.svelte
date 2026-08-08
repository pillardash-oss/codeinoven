<script lang="ts">
  import { onMount } from 'svelte'
  import RemoteClientView from '$lib/components/remote/RemoteClientView.svelte'
  import CloudRemoteAccess from '$lib/components/remote/CloudRemoteAccess.svelte'
  import { remoteSession } from '$lib/remote/session-store.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { applyTheme, resolveTheme, watchSystemDark } from '$lib/theme'

  let { onBack = () => undefined }: { onBack?: () => void } = $props()

  let connected = $derived(
    remoteSession.snapshot.route.kind === 'LAN_CONNECTED' ||
      remoteSession.snapshot.route.kind === 'RELAY_CONNECTED'
  )

  let hasLanPairing = $derived(
    typeof window !== 'undefined' &&
      (new URLSearchParams(window.location.search).has('pair') ||
        new URLSearchParams(window.location.hash.slice(1)).has('pair'))
  )

  // The desktop shell applies the theme from its own root component, which the
  // phone never mounts. Without this the client is stuck in light mode.
  let systemDark = $state(false)
  let preference = $state<'system' | 'light' | 'dark'>('system')

  function applyCurrentTheme(): void {
    applyTheme(resolveTheme(preference, systemDark))
  }

  /** The desktop's configured theme only becomes readable once the bridge is
   *  live; until then the phone's own colour scheme is the best approximation. */
  function syncDesktopTheme(): void {
    void invoke('config:get')
      .then((config) => {
        preference = config.theme
        applyCurrentTheme()
      })
      .catch(() => applyCurrentTheme())
  }

  onMount(() => {
    const stopWatching = watchSystemDark((dark) => {
      systemDark = dark
      applyCurrentTheme()
    })
    applyCurrentTheme()
    return stopWatching
  })
</script>

{#if connected}
  {#await import('./RemoteMobileShell.svelte') then { default: RemoteMobileShell }}
    <RemoteMobileShell
      onDisconnect={() => remoteSession.disconnect()}
      onConnected={syncDesktopTheme}
    />
  {:catch error}
    <div
      class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-foreground"
    >
      <p class="text-[15px] font-medium">Could not load the workspace</p>
      <p class="max-w-72 text-[13px] leading-relaxed text-dimmed">
        {error instanceof Error ? error.message : 'The remote workspace could not be loaded.'}
      </p>
    </div>
  {/await}
{:else}
  {#if hasLanPairing}
    <RemoteClientView pwa {onBack} />
  {:else}
    <CloudRemoteAccess />
  {/if}
{/if}
