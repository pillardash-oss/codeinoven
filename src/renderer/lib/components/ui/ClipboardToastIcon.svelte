<script lang="ts">
  import CioClipboardCheck from '$lib/components/icons/cio/CioClipboardCheck.svelte'
  /**
   * The copy confirmation's card icon, as svelte-sonner draws it.
   *
   * Sonner renders a per-toast `icon` component with no props, so the size
   * lives here rather than at the call site. It is the same size as
   * `MemoryToastIcon.svelte`, because both lead a card the same way: a mark in
   * the chip that tells one card apart from the others in the stack.
   */
</script>

<CioClipboardCheck size={18} />
