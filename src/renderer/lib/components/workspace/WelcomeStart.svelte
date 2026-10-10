<script lang="ts">
  import {
    Clock1,
    FolderGit2,
    FolderPlus,
    GraduationCap,
    MessageSquarePlus,
    PanelLeft,
    Settings2,
    Workflow
  } from '@lucide/svelte'
  import type { Component } from 'svelte'
  import { publicAssetUrl } from '$lib/static-assets'
  import type { WorkspaceTourView } from '../onboarding/onboarding-tour-steps'

  interface Props {
    /**
     * Which view's empty state this is. Projects and Threads share their body
     * because both need a project before there is anything to show, and differ
     * in the sidebar they toggle and the tour they open. Chats and Assistant
     * have their own instructions and actions.
     */
    variant?: 'projects' | 'threads' | 'chats' | 'assistant'
    /**
     * Whether the view's sidebar holds anything right now. A sidebar with
     * nothing in it is not rendered at all, so the toggle row is offered only
     * while there is something for it to reveal.
     */
    sidebarHasContent?: boolean
    /** Toggle the shared sidebar visibility. */
    onToggleSidebar?: () => void
    /** Start a standalone chat without a project. */
    onNewChat?: () => void
    /** Start the new-routine flow (Assistant). */
    onNewRoutine?: () => void
    /** Create a routine-less task (Assistant). */
    onNewTask?: () => void
    /** Open the add-project flow. */
    onAddProject?: () => void
    /** Open the clone-from-git flow. */
    onCloneRepo?: () => void
    /** Open the settings view. */
    onOpenSettings?: () => void
    /** Open this view's own tour. */
    onShowTour?: () => void
  }

  let {
    variant = 'projects',
    sidebarHasContent = false,
    onToggleSidebar,
    onNewChat,
    onNewRoutine,
    onNewTask,
    onAddProject,
    onCloneRepo,
    onOpenSettings,
    onShowTour
  }: Props = $props()

  const logoUrl = publicAssetUrl('icon-mono.svg')

  interface ActionItem {
    id: string
    icon: Component
    title: string
    description: string
    run: () => void
    /** Renders the row with the accent treatment so it reads as the primary entry. */
    highlight?: boolean
  }

  const subtitles: Record<'projects' | 'threads' | 'chats' | 'assistant', string> = {
    projects: 'What would you like to work on?',
    threads: 'Every project conversation, in one timeline',
    chats: 'Ask a question or start a conversation, no project needed',
    assistant: 'Jobs the agent runs for you, on their own schedule'
  }

  const settingsAction = (): ActionItem => ({
    id: 'settings',
    icon: Settings2,
    title: 'Open settings',
    description: 'Configure agents, models, and preferences',
    run: () => onOpenSettings?.()
  })

  const tourAction = (view: WorkspaceTourView): ActionItem => ({
    id: 'tour',
    icon: GraduationCap,
    title: 'Learn what CodeInOven can do',
    description: `Get a tour of the ${view} view`,
    run: () => onShowTour?.()
  })

  /** The first row carries the accent treatment when no row claims it, so the
   *  list always reads as one recommended next step. */
  function withLeadHighlight(items: ActionItem[]): ActionItem[] {
    if (items.length === 0 || items.some((item) => item.highlight)) return items
    return items.map((item, index) => (index === 0 ? { ...item, highlight: true } : item))
  }

  /** The Assistant's empty state: a routine first, then a one-off task, then
   *  the app's own settings, then its tour. */
  function assistantActions(): ActionItem[] {
    const items: ActionItem[] = []
    if (onNewRoutine) {
      items.push({
        id: 'new-routine',
        icon: Workflow,
        title: 'Start a new routine',
        description: 'A job that repeats, with a how-to the agent works from',
        run: () => onNewRoutine?.(),
        highlight: true
      })
    }
    if (onNewTask) {
      items.push({
        id: 'new-task',
        icon: Clock1,
        title: 'Start a new task',
        description: 'One piece of work for the agent, with no schedule',
        run: () => onNewTask?.()
      })
    }
    if (onOpenSettings) items.push(settingsAction())
    if (onShowTour) items.push(tourAction('assistant'))
    return items
  }

  function chatActions(): ActionItem[] {
    const items: ActionItem[] = []
    if (onNewChat) {
      items.push({
        id: 'new-chat',
        icon: MessageSquarePlus,
        title: 'New chat',
        description: 'Start a conversation with an agent',
        run: () => onNewChat?.(),
        highlight: true
      })
    }
    if (sidebarHasContent && onToggleSidebar) {
      items.push({
        id: 'toggle-sidebar',
        icon: PanelLeft,
        title: 'Toggle chats sidebar',
        description: 'Choose an existing chat to continue the conversation',
        run: () => onToggleSidebar?.()
      })
    }
    if (onOpenSettings) items.push(settingsAction())
    if (onShowTour) items.push(tourAction('chats'))
    return withLeadHighlight(items)
  }

  /** Projects and Threads: the same way in (a project), reached from either
   *  view, with the sidebar toggle only while there is a sidebar to toggle. */
  function workspaceActions(): ActionItem[] {
    const items: ActionItem[] = []
    if (sidebarHasContent && onToggleSidebar) {
      items.push({
        id: 'toggle-sidebar',
        icon: PanelLeft,
        title: variant === 'threads' ? 'Toggle threads sidebar' : 'Toggle project sidebar',
        description: 'Hover on a project to create a new thread',
        run: () => onToggleSidebar?.(),
        highlight: true
      })
    }
    if (onAddProject) {
      items.push({
        id: 'add-project',
        icon: FolderPlus,
        title: 'Add project',
        description: 'Create one from a local folder',
        run: () => onAddProject?.()
      })
    }
    if (onCloneRepo) {
      items.push({
        id: 'clone-repo',
        icon: FolderGit2,
        title: 'Clone repository',
        description: 'Add a project from a git URL',
        run: () => onCloneRepo?.()
      })
    }
    if (onOpenSettings) items.push(settingsAction())
    if (onNewChat) {
      items.push({
        id: 'new-chat',
        icon: MessageSquarePlus,
        title: 'New chat',
        description: 'Start a conversation, no project needed',
        run: () => onNewChat?.()
      })
    }
    if (onShowTour) items.push(tourAction(variant))
    return withLeadHighlight(items)
  }

  const actions = $derived(
    variant === 'assistant'
      ? assistantActions()
      : variant === 'chats'
        ? chatActions()
        : workspaceActions()
  )
</script>

<div class="flex h-full flex-col items-center justify-center px-6">
  <img src={logoUrl} alt="CodeInOven" class="mb-8 h-20 w-20" draggable="false" />
  <h1 class="text-[1.0625rem] font-semibold tracking-tight text-foreground">CodeInOven</h1>
  <p class="mt-1 text-[0.8125rem] text-muted">{subtitles[variant]}</p>

  <div class="mt-8 flex w-full max-w-sm flex-col gap-1" data-onboarding="empty-state-actions">
    {#each actions as action (action.id)}
      <button
        type="button"
        class="group flex w-full items-center gap-3.5 rounded-xl px-3 py-2.5 text-left outline-none transition-colors hover:bg-elevated focus-visible:bg-elevated"
        onclick={action.run}
      >
        <span
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors
            {action.highlight
            ? 'bg-primary/10 group-hover:bg-primary/20'
            : 'bg-elevated group-hover:bg-overlay'}"
        >
          <action.icon size={16} class={action.highlight ? 'text-primary' : 'text-muted'} />
        </span>
        <span class="min-w-0">
          <span class="block text-[0.8125rem] font-medium text-foreground">{action.title}</span>
          <span class="block text-[0.75rem] leading-snug text-muted">{action.description}</span>
        </span>
      </button>
    {/each}
  </div>
</div>
