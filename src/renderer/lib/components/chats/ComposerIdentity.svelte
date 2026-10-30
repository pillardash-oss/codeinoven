<script lang="ts" module>
  import type { ComposerProject, Assistant, Thread } from '$shared/types'

  /**
   * The subset of a thread an assistant task's mark is drawn from: the same
   * fields the sidebar row and the task's own icon slot read.
   */
  export type ComposerTaskIdentity = Pick<
    Thread,
    | 'id'
    | 'projectId'
    | 'title'
    | 'assistantIconType'
    | 'assistantGettingStarted'
    | 'assistantTaskId'
  >

  /**
   * What a composer is writing into. The composer shoe states this once, and
   * every surface the app can write into is one member of this union:
   *
   * - `project`: a thread of a project, named by the project.
   * - `chat`: a plain conversation   a temporary chat, or the chats view   which
   *    has no project, no assistant and no page behind it, so it is named by what
   *    it is. A temporary chat keeps its own mark, because it is the same object
   *    as a chat with one thing missing: it writes nothing and expires.
   * - `assistant`: an assistant thread that belongs to an assistant, named by the
   *   assistant it belongs to.
   * - `task`: an assistant task that belongs to no assistant, named by itself.
   * - `browser-agent`: a browser tab's assistant conversation, named by what it
   *   is: the agent that answers about the page in that tab.
   *
   * Adding a surface is one member here and one branch in the markup: the
   * resolution of names, marks and the truncating stages lives in this component.
   */
  export type ComposerIdentity =
    | {
        kind: 'project'
        /** Project the thread belongs to; names the picker's current value. */
        activeProjectId: string
        project?: ComposerProject
        /** False once a message has been sent: the picker is then a plain label. */
        interactive: boolean
        /** Reassigns the thread's project; only honoured before the first message. */
        onSwitchProject?: (projectId: string) => void
      }
    | {
        kind: 'chat'
        /** The side chat a panel opens: a chat that reads this project's context
         *  but writes nothing and expires on its own. */
        temporary?: boolean
      }
    | { kind: 'assistant'; assistant: Assistant }
    | {
        kind: 'task'
        task: ComposerTaskIdentity
        /** Assistant accent tinting a custom task mark; the shared fallback otherwise. */
        color?: string
      }
    | { kind: 'browser-agent' }
</script>

<script lang="ts">
  import AssistantIcon from '$lib/components/icons/cio/AssistantIcon.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioFolder from '@pdslng/cio-icon/CioFolder.svelte'
  import CioTemporaryChat from '@pdslng/cio-icon/CioTemporaryChat.svelte'
  import { hasProjectNameCollision } from '$lib/project-location'
  import {
    ASSISTANT_ICON_FALLBACK_COLOR,
    AssistantDefaultIcon,
    getAssistantIcon,
    assistantAccentColor
  } from '$lib/assistant-icons'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { assistants } from '$lib/stores/assistants.svelte'
  import { CONTENT_FAMILY_ICONS } from '$lib/content-view-icons'
  import { effectiveThreadTitle } from '$lib/stores/draft-label'
  import { scopeState } from '$lib/stores/scope.svelte'
  import ProjectIdentity from '$lib/components/shared/ProjectIdentity.svelte'
  import ProjectSwitch from '$lib/components/shared/ProjectSwitch.svelte'
  import { taskRowIconKey } from '$lib/components/assistant/assistant-view'

  interface Props {
    identity: ComposerIdentity
  }

  let { identity }: Props = $props()

  /** The surface's own name, for the tooltip when the label has to truncate. */
  let taskTitle = $derived(identity.kind === 'task' ? effectiveThreadTitle(identity.task) : '')
  /** The task's mark: its own custom icon, else the sidebar row's own fallback. */
  let taskIcon = $derived(
    identity.kind === 'task' && identity.task.assistantIconType
      ? getIconSvgDataUrl(
          identity.task.assistantIconType,
          identity.color ?? ASSISTANT_ICON_FALLBACK_COLOR
        )
      : null
  )
  let taskIconKey = $derived(identity.kind === 'task' ? taskRowIconKey(identity.task) : 'task')
  let taskAccent = $derived(identity.kind === 'task' ? (identity.color ?? null) : null)

  /** The assistant's mark, resolved exactly as its sidebar row resolves it. */
  let assistantIcon = $derived(
    identity.kind === 'assistant'
      ? getAssistantIcon(identity.assistant, assistants.iconUrls.get(identity.assistant.id) ?? null)
      : null
  )
</script>

{#if identity.kind === 'project'}
  <!-- A project's identity is its own live picker: it reassigns the thread's
       project until the first message is sent, and reads as a label after. -->
  <ProjectSwitch
    activeProjectId={identity.activeProjectId}
    onSwitch={identity.interactive ? identity.onSwitchProject : undefined}
    disabled={!identity.interactive}
    side="top"
    align="start"
    class="composer-identity shoe-project group flex h-6 max-w-48 min-w-0 shrink items-center justify-start gap-1.5 px-1.5 text-[0.6875rem] text-muted hover:bg-elevated hover:text-foreground"
    ariaLabel={identity.interactive
      ? 'Change the project of this new thread'
      : `Project: ${identity.project?.name ?? 'none'}`}
  >
    {#if identity.project?.iconUrl}
      <img src={identity.project.iconUrl} alt="" class="h-3.5 w-3.5 shrink-0" />
    {:else}
      <CioFolder
        size={13}
        class="shrink-0 text-dimmed transition-colors group-hover:text-foreground"
      />
    {/if}
    {#if identity.project}
      <!-- The label is wrapped in this component's own element, so the
           truncating tiers below reach it: a class handed to a child component as
           a prop carries no scope hash, and the tiers would silently miss it. -->
      <span class="composer-identity-label min-w-0">
        <ProjectIdentity
          project={identity.project}
          class="min-w-0"
          nameClass="text-[0.6875rem] font-medium text-foreground"
          locationClass="shoe-identity-location text-[0.5625rem] text-dimmed"
          showLocation={hasProjectNameCollision(identity.project, scopeState.projectRecords)}
        />
      </span>
    {/if}
    {#if identity.interactive}
      <span
        class="composer-identity-chevron shrink-0 text-dimmed transition-transform duration-200 group-hover:text-foreground group-aria-expanded:rotate-180 group-aria-expanded:text-foreground"
      >
        <CioChevronDown size={11} />
      </span>
    {/if}
  </ProjectSwitch>
{:else if identity.kind === 'assistant'}
  <span
    class="composer-identity flex h-6 min-w-0 shrink items-center gap-1.5 px-1.5 text-[0.6875rem] text-muted"
    title="Assistant: {identity.assistant.name}"
  >
    {#if assistantIcon}
      <img src={assistantIcon} alt="" class="h-3.5 w-3.5 shrink-0 object-contain" />
    {:else}
      <AssistantDefaultIcon size={13} style="color: {assistantAccentColor(identity.assistant)}" />
    {/if}
    <span class="composer-identity-label min-w-0 truncate font-medium text-foreground"
      >{identity.assistant.name}</span
    >
  </span>
{:else if identity.kind === 'task'}
  <span
    class="composer-identity flex h-6 min-w-0 shrink items-center gap-1.5 px-1.5 text-[0.6875rem] text-muted"
    title="Task: {taskTitle}"
  >
    {#if taskIcon}
      <img src={taskIcon} alt="" class="h-3.5 w-3.5 shrink-0 object-contain" />
    {:else if taskIconKey === 'knowledge'}
      <AssistantIcon
        mark="knowledge"
        size={13}
        class="shrink-0 text-dimmed"
        style={taskAccent ? `color: ${taskAccent}` : ''}
      />
    {:else if taskIconKey === 'run'}
      <AssistantIcon
        mark="run"
        size={13}
        class="shrink-0 text-dimmed"
        style={taskAccent ? `color: ${taskAccent}` : ''}
      />
    {:else}
      <AssistantIcon
        mark="task"
        size={13}
        class="shrink-0 text-dimmed"
        style={taskAccent ? `color: ${taskAccent}` : ''}
      />
    {/if}
    <span class="composer-identity-label min-w-0 truncate font-medium text-foreground"
      >{taskTitle}</span
    >
  </span>
{:else if identity.kind === 'browser-agent'}
  <!-- A browser tab's conversation is the browsing agent's own, and it wears the
       mark the rail's agent conversation tab wears so the shoe and the tab read
       as one thing. -->
  {@const BrowseAgentIcon = CONTENT_FAMILY_ICONS.chats}
  <span
    class="composer-identity flex h-6 min-w-0 shrink items-center gap-1.5 px-1.5 text-[0.6875rem] text-muted"
    title="Browse agent: it answers about the page this browser tab is on"
  >
    <BrowseAgentIcon size={13} class="shrink-0 text-dimmed" />
    <span class="composer-identity-label min-w-0 truncate font-medium text-foreground"
      >Browse agent</span
    >
  </span>
{:else if identity.temporary}
  <!-- A temporary chat is named by the object it is, and it keeps the mark the
       sidebar's temporary chat tabs carry, so the shoe and the tab read as one
       thing. Unlike a plain chat it has a mark to show, so its word truncates
       with the other labels instead of holding its width. -->
  <span
    class="composer-identity flex h-6 min-w-0 shrink items-center gap-1.5 px-1.5 text-[0.6875rem] text-muted"
    title="A temporary chat: it reads this project's context, writes nothing, and expires"
  >
    <CioTemporaryChat size={13} class="shrink-0 text-dimmed" />
    <span class="composer-identity-label min-w-0 truncate font-medium text-foreground"
      >Temporary chat</span
    >
  </span>
{:else}
  <!-- A plain chat has nothing to name it by, so it is named by what it is. It
       carries no mark and keeps its word at every width: one short word is
       already the tightest this segment can be. -->
  <span
    class="composer-identity flex h-6 shrink-0 items-center px-1.5 text-[0.6875rem] text-muted"
    title="A plain chat: no project, no assistant, no page behind it"
  >
    <span class="font-medium text-foreground">Chat</span>
  </span>
{/if}

<style>
  /* The identity is the shoe's widest segment and the one that must still be
     readable when the row is tight, so it gives up its own label last. Every
     threshold below measures the shoe's own query container (the `.composer-shoe`
     wrapper), and the tiers line up with the shoe's: the name shortens here while
     the branch and the tips go, and it only surrenders to its mark when nothing
     else is left to drop.

     `composer-identity-chevron` belongs to ProjectSwitch, so only `:global`
     reaches it from here. */
  @container (max-width: 700px) {
    .composer-identity-label {
      max-width: 9rem;
    }
  }

  @container (max-width: 610px) {
    .composer-identity-label {
      max-width: 7rem;
    }
  }

  @container (max-width: 360px) {
    .composer-identity-label {
      display: none;
    }

    /* The project's picker keeps its chevron: with the name gone, the chevron is
       the only thing saying the mark opens a picker. */
  }
</style>
