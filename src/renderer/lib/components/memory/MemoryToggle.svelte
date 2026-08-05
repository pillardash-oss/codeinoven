<script lang="ts">
  import Switch from '../ui/Switch.svelte'
  import type { MemoryPriority } from '$shared/types'

  interface Props {
    enabled: boolean
    priority?: MemoryPriority
    onToggle: () => void
  }

  let { enabled, priority = 'medium', onToggle }: Props = $props()

  const activeClass = $derived(
    priority === 'critical' ? 'bg-danger' : priority === 'high' ? 'bg-accent' : 'bg-primary'
  )
</script>

<Switch
  checked={enabled}
  onchange={onToggle}
  {activeClass}
  title={enabled ? 'Disable this memory entry' : 'Enable this memory entry'}
  aria-label={enabled ? 'Disable memory entry' : 'Enable memory entry'}
/>
