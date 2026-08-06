<script lang="ts">
  import RemoteClientView from '$lib/components/remote/RemoteClientView.svelte'
  import RemoteChatApp from '$lib/components/remote/RemoteChatApp.svelte'
  import { remoteSession } from '$lib/remote/session-store.svelte'

  let { onBack = () => undefined }: { onBack?: () => void } = $props()

  let connected = $derived(
    remoteSession.snapshot.route.kind === 'LAN_CONNECTED' ||
      remoteSession.snapshot.route.kind === 'RELAY_CONNECTED'
  )
</script>

{#if connected}
  <RemoteChatApp onDisconnect={() => remoteSession.disconnect()} />
{:else}
  <!-- RemoteClientView handles the QR pairing `?pair=` auto-connect on the
       phone, and falls back to a manual secret entry screen. -->
  <RemoteClientView pwa {onBack} />
{/if}
