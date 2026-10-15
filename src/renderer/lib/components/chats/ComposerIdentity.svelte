<script lang="ts" module>
  import type { ComposerProject, Routine, Thread } from '$shared/types'

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
   *    has no project, no routine and no page behind it, so it is named by what
   *    it is.
   * - `routine`: an assistant thread that belongs to a routine, named by the
   *   routine it belongs to.
   * - `task`: an assistant task that belongs to no routine, named by itself.
   * - `browser-tab`: a browser tab's assistant conversation, named by the tab it
   *   answers about.
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
    | { kind: 'chat' }
    | { kind: 'routine'; routine: Routine }
    | {
        kind: 'task'
        task: ComposerTaskIdentity
        /** Routine accent tinting a custom task mark; the shared fallback otherwise. */
        color?: string
      }
    | { kind: 'browser-tab'; tabId: string }
</script>

<script lang="ts">
  import { ChevronDown, Folder, Globe } from '@lucide/svelte'
  import AssistantIcon from '$lib/components/icons/AssistantIcon.svelte'
  import { hasProjectNameCollision } from '$lib/project-location'
  import {
    ROUTINE_ICON_FALLBACK_COLOR,
    RoutineDefaultIcon,
    getRoutineIcon,
    routineAccentColor
  } from '$lib/routine-icons'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { browserTabLabel } from '$lib/stores/global-browser-types'
  import { faviconState } from '$lib/stores/favicons.svelte'
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
          identity.color ?? ROUTINE_ICON_FALLBACK_COLOR
        )
      : null
  )
  let taskIconKey = $derived(identity.kind === 'task' ? taskRowIconKey(identity.task) : 'task')
  let taskAccent = $derived(identity.kind === 'task' ? (identity.color ?? null) : null)

  /** The routine's mark, resolved exactly as its sidebar row resolves it. */
  let routineIcon = $derived(
    identity.kind === 'routine'
      ? getRoutineIcon(
          identity.routine,
          assistantRoutines.iconUrls.get(identity.routine.id) ?? null
        )
      : null
  )

  /** The page a browser conversation answers about, read through its tab. */
  let pageTab = $derived(
    identity.kind === 'browser-tab' ? globalBrowser.tabById(identity.tabId) : null
  )
  let pageUrl = $derived(pageTab?.url ?? '')
  let pageLabel = $derived(pageTab ? browserTabLabel(pageTab).trim() : '')
  let pageFavicon = $derived(
    pageTab?.favicon ?? (pageUrl !== '' ? faviconState.faviconFor(pageUrl) : null)
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
      <Folder
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
        <ChevronDown size={11} />
      </span>
    {/if}
  </ProjectSwitch>
{:else if identity.kind === 'routine'}
  <span
    class="composer-identity flex h-6 min-w-0 shrink items-center gap-1.5 px-1.5 text-[0.6875rem] text-muted"
    title="Routine: {identity.routine.name}"
  >
    {#if routineIcon}
      <img src={routineIcon} alt="" class="h-3.5 w-3.5 shrink-0 object-contain" />
    {:else}
      <RoutineDefaultIcon
        size={13}
        style="color: {routineAccentColor(identity.routine)}"
      />
    {/if}
    <span class="composer-identity-label min-w-0 truncate font-medium text-foreground"
      >{identity.routine.name}</span
    >
  </span>
{:else if identity.kind === 'task'}
  <span
    class="composer-identity flex h-6 min-w-0 shrink items-center gap-1.5 px-1.5 text-[0.6875rem] text-muted"
    title="Task: {taskTitle}"
  >
    {#if taskIcon}
      <img src={taskIcon} alt="" class="h-3.5 w-3.5 shrink-0 object-contain" />
    {:else if taskIconKey === 'how-to'}
      <AssistantIcon
        mark="how-to"
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
{:else if identity.kind === 'browser-tab'}
  <span
    class="composer-identity flex h-6 min-w-0 shrink items-center gap-1.5 px-1.5 text-[0.6875rem] text-muted"
    title="Browser tab: {pageLabel || 'this page'}"
    {@attach () => {
      // The tab carries its own icon once the app has seen one; this warms the
      // shared cache for a tab that has none yet. It asks at most once per host.
      if (pageUrl !== '') faviconState.ensureResolved([pageUrl])
    }}
  >
    {#if pageFavicon}
      <img src={pageFavicon} alt="" class="h-3.5 w-3.5 shrink-0 object-contain" />
    {:else}
      <Globe size={13} class="shrink-0 text-dimmed" />
    {/if}
    {#if pageLabel !== ''}
      <span class="composer-identity-label min-w-0 truncate font-medium text-foreground"
        >{pageLabel}</span
      >
    {/if}
  </span>
{:else}
  <!-- A plain chat has nothing to name it by, so it is named by what it is. It
       carries no mark and keeps its word at every width: one short word is
       already the tightest this segment can be. -->
  <span
    class="composer-identity flex h-6 shrink-0 items-center px-1.5 text-[0.6875rem] text-muted"
    title="A plain chat: no project, no routine, no page behind it"
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
