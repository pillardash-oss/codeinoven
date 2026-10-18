<script lang="ts">
  import CommandPalette from '$lib/components/actions/CommandPalette.svelte'

  /**
   * Owns the spotlight's `screenKey` as reactive state, because a mounted
   * component cannot rewrite its own props. The app shell swaps the key on one
   * mounted palette when the reader moves between spotlight screens, so the test
   * does the same through this wrapper to prove the query input survives.
   */
  let { initialScreenKey }: { initialScreenKey: string } = $props()

  // Intentional initial-value capture: the harness owns the key from mount on.
  // svelte-ignore state_referenced_locally
  let screenKey = $state(initialScreenKey)

  export function setScreenKey(next: string): void {
    screenKey = next
  }
</script>

<CommandPalette open {screenKey} actions={[]} onSelect={() => {}} onClose={() => {}} />
