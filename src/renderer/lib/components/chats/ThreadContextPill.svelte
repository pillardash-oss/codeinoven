<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioMessage from '@pdslng/cio-icon/CioMessage.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import type { ThreadContextReference } from '$lib/thread-context'

  interface Props {
    reference: ThreadContextReference
    onRemove: () => void
  }

  let { reference, onRemove }: Props = $props()

  /** The icon of the project the attached thread lives in. A project this window
   *  never loaded falls back to a conversation mark rather than to a blank. */
  const projectIconUrl = $derived(
    scopeState.projects.find((project) => project.id === reference.projectId)?.iconUrl ?? null
  )
</script>

<!-- One conversation attached to the message as context: the project it lives in,
     the thread it names, and the control that detaches it. Detaching drops the
     lookup the agent was handed, so this is the whole life cycle of the
     attachment in one control. -->
<div
  class="flex items-stretch overflow-hidden border border-info/30 bg-info/10 text-[0.6875rem] text-muted transition-colors"
>
  <span
    class="flex min-w-0 items-center gap-1.5 py-1 pr-1 pl-2"
    title={`Context thread: ${reference.title}   the agent may look it up if the message needs it`}
  >
    {#if projectIconUrl}
      <img src={projectIconUrl} alt="" class="h-3 w-3 shrink-0 object-contain" draggable="false" />
    {:else}
      <CioMessage size={11} class="shrink-0 text-info" />
    {/if}
    <span class="max-w-40 truncate">{reference.title}</span>
  </span>
  <button
    type="button"
    class="flex shrink-0 items-center justify-center border-l border-info/30 px-2.5 text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
    title={`Detach ${reference.title} from this message`}
    aria-label={`Detach ${reference.title} from this message`}
    onclick={onRemove}
  >
    <CioClose size={11} />
  </button>
</div>
