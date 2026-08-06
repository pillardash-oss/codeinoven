<script lang="ts">
  import RemoteClientView from '$lib/components/remote/RemoteClientView.svelte'

  let { onBack = () => undefined }: { onBack?: () => void } = $props()
</script>

<RemoteClientView pwa {onBack} />
