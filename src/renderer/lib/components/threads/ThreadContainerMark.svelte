<script lang="ts">
  import CioChat from '@pdslng/cio-icon/CioChat.svelte'
  import { AssistantDefaultIcon, getAssistantIcon } from '$lib/assistant-icons'
  import { threadContainerMark, type ThreadContainerMark as Mark } from '$lib/thread-container-mark'
  import { assistants } from '$lib/stores/assistants.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'

  interface Props {
    /** The container the thread lives in: its project, or a hidden one. */
    projectId: string
    /** The assistant owning an assistant thread, when the caller can resolve it. */
    assistantId?: string | null
    /** Side of the square mark, in pixels. */
    size?: number
    /** Ink and spacing for the glyph; an image keeps its own colours. */
    class?: string
  }

  let { projectId, assistantId = null, size = 11, class: className = '' }: Props = $props()

  /** The assistant behind an assistant thread, when the caller named one. */
  let assistant = $derived(
    assistantId
      ? (assistants.assistants.find((candidate) => candidate.id === assistantId) ?? null)
      : null
  )

  let mark: Mark = $derived(
    threadContainerMark(
      { projectId },
      {
        projectIconUrl:
          scopeState.projects.find((project) => project.id === projectId)?.iconUrl ?? null,
        assistant,
        assistantIconUrl: assistant
          ? getAssistantIcon(assistant, assistants.iconUrls.get(assistant.id) ?? null)
          : null
      }
    )
  )
</script>

{#if mark.kind === 'image'}
  <img
    src={mark.url}
    alt=""
    width={size}
    height={size}
    class="shrink-0 object-contain {className}"
    draggable="false"
  />
{:else if mark.kind === 'assistant'}
  <AssistantDefaultIcon {size} class="shrink-0 {className}" style="color: {mark.color}" />
{:else}
  <CioChat {size} class="shrink-0 {className}" />
{/if}
