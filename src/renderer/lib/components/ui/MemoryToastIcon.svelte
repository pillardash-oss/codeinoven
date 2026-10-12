<script lang="ts">
  import { BrainCircuit } from '@lucide/svelte'

  /**
   * The memory proposal's card icon, as svelte-sonner draws it.
   *
   * Sonner renders a per-toast `icon` component with no props, so the size
   * lives here rather than at the call site. It matches the stack's other
   * icons (`ToastStack.svelte` renders those at 15 / 2.25).
   */
</script>

<BrainCircuit size={15} stroke-width={2.25} />
