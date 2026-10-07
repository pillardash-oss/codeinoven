<script lang="ts">
  import StatusPill from '$lib/components/ui/StatusPill.svelte'
  let { name }: { name: string } = $props()
</script>

<span>Profile <StatusPill tone="info"><strong>{name}</strong></StatusPill> already exists.</span>
