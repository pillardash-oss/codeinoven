<script lang="ts">
  import { ICON_SIZE } from '$lib/components/icons/cio/scale'
  import { encodeShortcutTokens } from '$lib/keymap/keymap'

  import type { LayoutToggle } from './AppHeaderNavigationController.svelte'

  interface Props {
    /** The folded pair's second layout: Thread beside the project view, Scoped
     *  beside the board. */
    toggle: LayoutToggle
  }

  let { toggle }: Props = $props()

  let ToggleIcon = $derived(toggle.icon)
</script>

<button
  class="flex h-7 w-7 items-center justify-center transition-colors duration-150 {toggle.pressed
    ? 'bg-elevated text-foreground'
    : 'text-muted hover:bg-elevated hover:text-foreground'}"
  aria-label={toggle.label}
  aria-pressed={toggle.pressed}
  title={toggle.label}
  data-shortcut={encodeShortcutTokens(toggle.keys)}
  onclick={toggle.select}
>
  <ToggleIcon size={ICON_SIZE.control} />
</button>
