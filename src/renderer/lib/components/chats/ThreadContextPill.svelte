<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import ThreadContainerMark from '$lib/components/threads/ThreadContainerMark.svelte'
  import type { ThreadContextReference } from '$lib/thread-context'

  interface Props {
    reference: ThreadContextReference
    /** Brings the attached conversation into view. The badge names a thread the
     *  user can already read, so clicking the name opens it. */
    onOpen: () => void
    /**
     * Detaches the reference. Absent when the badge is the thread's own fork
     * parent: that is a fact about the conversation, not something the user
     * attached, so it carries no control that would suggest it can be undone.
     */
    onRemove?: () => void
    /** True when this badge stands for the thread the conversation was forked
     *  from, so the titles say why it is there. */
    forkedFrom?: boolean
  }

  let { reference, onOpen, onRemove, forkedFrom = false }: Props = $props()

  const openTitle = $derived(
    forkedFrom
      ? `Open ${reference.title}   this thread was forked from it, so the agent can read it for context`
      : `Open ${reference.title}   attached to this message as context`
  )
</script>

<!-- One conversation attached to the message as context: the project it lives in,
     the thread it names, and the control that detaches it. Clicking the name opens
     the conversation so the user can check what they attached, and detaching drops
     the lookup the agent was handed, so this is the whole life cycle of the
     attachment in one control. -->
<div
  class="flex items-stretch overflow-hidden border border-info/30 bg-info/10 text-[0.6875rem] text-muted transition-colors"
>
  <button
    type="button"
    class="flex min-w-0 items-center gap-1.5 py-1 pr-1 pl-2 transition-colors hover:bg-info/15 hover:text-foreground"
    title={openTitle}
    aria-label={`Open ${reference.title}`}
    onclick={onOpen}
  >
    <!-- The mark of the container the attached thread lives in, which is the
         same mark the delivered message keeps: attaching and sending never
         changes which project, chat or assistant the thread belongs to. -->
    <ThreadContainerMark projectId={reference.projectId} size={11} class="text-info" />
    <span class="max-w-40 truncate">{reference.title}</span>
  </button>
  {#if onRemove}
    <button
      type="button"
      class="flex shrink-0 items-center justify-center border-l border-info/30 px-2.5 text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
      title={`Detach ${reference.title} from this message`}
      aria-label={`Detach ${reference.title} from this message`}
      onclick={onRemove}
    >
      <CioClose size={11} />
    </button>
  {/if}
</div>
