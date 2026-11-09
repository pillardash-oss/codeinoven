<script lang="ts">
  import CioMessage from '@pdslng/cio-icon/CioMessage.svelte'
  import { AssistantDefaultIcon, getAssistantIcon } from '$lib/assistant-icons'
  import { getProjectIcon } from '$lib/project-icons'
  import { assistants } from '$lib/stores/assistants.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'

  interface Props {
    /** The blocked thread the card below belongs to. */
    projectId: string
    threadTitle: string
    assistantId?: string
  }

  let { projectId, threadTitle, assistantId }: Props = $props()

  /** The mark of whatever the blocked thread works as: the assistant's own icon
   *  when it runs as one, otherwise the project's. A window that never loaded
   *  that project falls back to a conversation mark rather than a blank, exactly
   *  like the composer's own context pill. */
  const assistant = $derived(
    assistantId ? (assistants.assistants.find((entry) => entry.id === assistantId) ?? null) : null
  )
  const assistantIconUrl = $derived(
    assistant ? getAssistantIcon(assistant, assistants.iconUrls.get(assistant.id) ?? null) : null
  )
  const project = $derived(scopeState.projects.find((entry) => entry.id === projectId) ?? undefined)
  const projectIconUrl = $derived(
    project ? getProjectIcon(project, project.iconUrl ?? undefined) : null
  )
  const iconUrl = $derived(assistantIconUrl ?? projectIconUrl)
  const label = $derived(assistant?.name ?? project?.name ?? '')
</script>

<!-- The badge a mirrored card wears: the thread it belongs to, and whose mark it
     works under. It is the composer's context pill in tone and shape, because a
     card inside a conversation has to say which conversation it actually belongs
     to. -->
<div
  class="flex items-center gap-1.5 border border-info/30 bg-info/10 px-2 py-1 text-[0.6875rem] text-muted"
  title={`${threadTitle}${label ? ` in ${label}` : ''}`}
>
  {#if iconUrl}
    <img src={iconUrl} alt="" class="h-3 w-3 shrink-0 object-contain" draggable="false" />
  {:else if assistant}
    <AssistantDefaultIcon size={11} class="shrink-0 text-info" />
  {:else}
    <CioMessage size={11} class="shrink-0 text-info" />
  {/if}
  <span class="max-w-56 truncate text-foreground">{threadTitle}</span>
  {#if label}
    <span class="shrink-0 text-dimmed">· {label}</span>
  {/if}
</div>
