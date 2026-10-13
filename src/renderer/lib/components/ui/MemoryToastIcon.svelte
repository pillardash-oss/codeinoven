<script lang="ts">
  import { BrainCircuit } from '@lucide/svelte'

  /**
   * The memory proposal's card icon, as svelte-sonner draws it.
   *
   * Sonner renders a per-toast `icon` component with no props, so the size
   * lives here rather than at the call site. It is the same icon at the same
   * size the app's own memory card leads with (`MemoryToast.svelte`), because
   * this chip is what tells the memory proposal apart from every other card in
   * the stack.
   */
</script>

<BrainCircuit size={18} />
