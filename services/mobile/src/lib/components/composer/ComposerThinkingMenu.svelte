<script lang="ts">
  import { THINKING_OPTIONS } from '#lib/composer-choice'
  import type { ThinkingLevel } from '#lib/api/types'

  /**
   * The reasoning presets, the app's own seven, in its order. The level is a
   * choice the message carries, so picking one writes it to the thread.
   */
  interface Props {
    selected: ThinkingLevel
    onpick: (level: ThinkingLevel) => void
  }

  let { selected, onpick }: Props = $props()
</script>

<div class="cpanel think-menu" role="menu" aria-label="Thinking level">
  {#each THINKING_OPTIONS as option (option.id)}
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected === option.id}
      title={`Think at ${option.label}`}
      onclick={() => onpick(option.id)}
    >
      {option.label}
    </button>
  {/each}
</div>
