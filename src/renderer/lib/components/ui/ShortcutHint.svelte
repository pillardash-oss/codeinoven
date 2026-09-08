<script lang="ts">
  import { formatKeyCombo } from '$lib/keymap/keymap'

  interface Props {
    /** Symbolic key tokens, e.g. ['mod', '1']. */
    keys: readonly string[]
    class?: string
  }

  let { keys, class: className = '' }: Props = $props()

  const label = $derived(formatKeyCombo(keys))
</script>

<kbd
  class="inline-flex h-5 shrink-0 items-center justify-center rounded border border-border bg-elevated px-1 font-mono text-[0.625rem] leading-none text-dimmed {className}"
  aria-label="Keyboard shortcut: {label}"
>
  {label}
</kbd>
