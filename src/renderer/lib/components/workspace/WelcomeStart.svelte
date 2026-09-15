<script lang="ts">
  import {
    FolderGit2,
    FolderPlus,
    GraduationCap,
    MessageSquarePlus,
    PanelLeft,
    Settings2
  } from '@lucide/svelte'
  import type { Component } from 'svelte'
  import { publicAssetUrl } from '$lib/static-assets'

  interface Props {
    /**
     * Which shell view the empty state belongs to; drives the action order.
     * Projects mode leads with the sidebar toggle (a new chat there is
     * misleading), chats mode keeps New chat on top.
     */
    variant?: 'chats' | 'projects'
    /** Start a standalone chat without a project. */
    onNewChat: () => void
    /** Open the add-project flow. */
    onAddProject: () => void
    /** Open the clone-from-git flow. */
    onCloneRepo: () => void
    /** Toggle the shared project sidebar visibility. */
    onToggleSidebar: () => void
    /** Open the settings view. */
    onOpenSettings: () => void
    /** Open the getting-started tour. */
    onShowTour: () => void
  }

  let {
    variant = 'projects',
    onNewChat,
    onAddProject,
    onCloneRepo,
    onToggleSidebar,
    onOpenSettings,
    onShowTour
  }: Props = $props()

  const logoUrl = publicAssetUrl('icon-mono.svg')

  interface ActionItem {
    icon: Component
    title: string
    description: string
    run: () => void
    /** Renders the row with the accent treatment so it reads as the primary entry. */
    highlight?: boolean
  }

  const chatActions: ActionItem[] = [
    {
      icon: MessageSquarePlus,
      title: 'New chat',
      description: 'Start a conversation   no project needed',
      run: () => onNewChat()
    },
    {
      icon: FolderPlus,
      title: 'Add project',
      description: 'Create one from a local folder',
      run: () => onAddProject()
    },
    {
      icon: FolderGit2,
      title: 'Clone repository',
      description: 'Add a project from a git URL',
      run: () => onCloneRepo()
    },
    {
      icon: Settings2,
      title: 'Open settings',
      description: 'Configure agents, models, and preferences',
      run: () => onOpenSettings()
    },
    {
      icon: GraduationCap,
      title: 'Learn what CodeInOven can do',
      description: 'Get a tour of its capabilities',
      run: () => onShowTour()
    }
  ]

  const projectActions: ActionItem[] = [
    {
      icon: PanelLeft,
      title: 'Toggle project sidebar',
      description: 'Hover on a project to create a new thread',
      run: () => onToggleSidebar(),
      highlight: true
    },
    {
      icon: FolderPlus,
      title: 'Add project',
      description: 'Create one from a local folder',
      run: () => onAddProject()
    },
    {
      icon: FolderGit2,
      title: 'Clone repository',
      description: 'Add a project from a git URL',
      run: () => onCloneRepo()
    },
    {
      icon: Settings2,
      title: 'Open settings',
      description: 'Configure agents, models, and preferences',
      run: () => onOpenSettings()
    },
    {
      icon: MessageSquarePlus,
      title: 'New chat',
      description: 'Start a conversation   no project needed',
      run: () => onNewChat()
    },
    {
      icon: GraduationCap,
      title: 'Learn what CodeInOven can do',
      description: 'Get a tour of its capabilities',
      run: () => onShowTour()
    }
  ]

  const actions = $derived(variant === 'chats' ? chatActions : projectActions)
</script>

<div class="flex h-full flex-col items-center justify-center px-6">
  <img src={logoUrl} alt="CodeInOven" class="mb-8 h-20 w-20" draggable="false" />
  <h1 class="text-[1.0625rem] font-semibold tracking-tight text-foreground">CodeInOven</h1>
  <p class="mt-1 text-[0.8125rem] text-muted">What would you like to work on?</p>

  <div class="mt-8 flex w-full max-w-sm flex-col gap-1">
    {#each actions as action (action.title)}
      <button
        type="button"
        class="group flex w-full items-center gap-3.5 rounded-xl px-3 py-2.5 text-left outline-none transition-colors hover:bg-elevated focus-visible:bg-elevated"
        onclick={action.run}
      >
        <span
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors
            {action.highlight ? 'bg-primary/10 group-hover:bg-primary/20' : 'bg-elevated group-hover:bg-overlay'}"
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
