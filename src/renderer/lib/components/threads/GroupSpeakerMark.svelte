<script lang="ts">
  import AssistantIcon from '$lib/components/icons/cio/AssistantIcon.svelte'
  import { AssistantDefaultIcon } from '$lib/assistant-icons'

  /**
   * The 16px mark a group conversation puts in front of a speaker's name.
   *
   * A group thread holds several speakers, and their marks are how they are told
   * apart at a glance. Don is special in treatment only: it wears the same plate
   * its sidebar tile wears, its own mark in ink on the brand black, so the
   * orchestrator reads the same in the conversation as it does in the panel,
   * whatever the appearance.
   */
  interface Props {
    /** The speaker's resolved mark, a data URL, used by every speaker but Don. */
    icon?: string | null
    /** The speaker's accent, which the fallback mark is drawn in. */
    color?: string
    /** Draw the chip the way that speaker's own tile does: Don's mark on its plate. */
    plate?: boolean
  }

  let { icon = null, color, plate = false }: Props = $props()
</script>

<span
  class="flex size-4 shrink-0 items-center justify-center {plate ? 'bg-brand-plate' : ''}"
  aria-hidden="true"
>
  {#if plate}
    <AssistantIcon mark="mark" size={12} class="text-brand-ink" />
  {:else if icon}
    <img src={icon} alt="" class="size-4 object-contain" draggable="false" />
  {:else}
    <AssistantDefaultIcon size={16} style="color: {color ?? 'var(--color-muted)'}" />
  {/if}
</span>
