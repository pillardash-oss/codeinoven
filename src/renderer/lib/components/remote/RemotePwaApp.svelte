<script lang="ts">
  import RemoteClientView from '$lib/components/remote/RemoteClientView.svelte'
  import RemoteChatApp from '$lib/components/remote/RemoteChatApp.svelte'
  import { remoteSession } from '$lib/remote/session-store.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { applyTheme, resolveTheme, watchSystemDark } from '$lib/theme'

  let { onBack = () => undefined }: { onBack?: () => void } = $props()

  let connected = $derived(
    remoteSession.snapshot.route.kind === 'LAN_CONNECTED' ||
      remoteSession.snapshot.route.kind === 'RELAY_CONNECTED'
  )

  // The desktop shell applies the theme from its own root component, which the
  // phone never mounts. Without this the client is stuck in light mode.
  let systemDark = $state(false)
  let preference = $state<'system' | 'light' | 'dark'>('system')

  $effect(() => watchSystemDark((dark) => (systemDark = dark)))

  // The desktop's configured theme only becomes readable once the bridge is
  // live; until then the phone's own colour scheme is the best approximation.
  $effect(() => {
    if (!connected) return
    let active = true
    void invoke('config:get')
      .then((config) => {
        if (active) preference = config.theme
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  })

  $effect(() => applyTheme(resolveTheme(preference, systemDark)))
</script>

{#if connected}
  <RemoteChatApp onDisconnect={() => remoteSession.disconnect()} />
{:else}
  <!-- RemoteClientView handles the QR pairing `?pair=` auto-connect on the
       phone, and falls back to a manual secret entry screen. -->
  <RemoteClientView pwa {onBack} />
{/if}
