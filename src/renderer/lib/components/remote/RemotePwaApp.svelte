<script lang="ts">
  import { onMount } from 'svelte'
  import CloudRemoteAccess from '$lib/components/remote/CloudRemoteAccess.svelte'
  import RemoteMobileShell from '$lib/components/remote/RemoteMobileShell.svelte'
  import { remoteSession } from '$lib/remote/session-store.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { applyTheme, resolveTheme, watchSystemDark } from '$lib/theme'

  let connected = $derived(
    remoteSession.snapshot.route.kind === 'LAN_CONNECTED' ||
      remoteSession.snapshot.route.kind === 'RELAY_CONNECTED'
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
  <RemoteMobileShell
    onDisconnect={() => remoteSession.disconnect()}
    onConnected={syncDesktopTheme}
  />
{:else}
  <CloudRemoteAccess />
{/if}
