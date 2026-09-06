<script lang="ts">
  import {
    FolderGit2,
    FolderPlus,
    GraduationCap,
    MessageSquarePlus,
    Settings2
  } from '@lucide/svelte'
  import { publicAssetUrl } from '$lib/static-assets'

  interface Props {
    /** Start a standalone chat without a project. */
    onNewChat: () => void
    /** Open the add-project flow. */
    onAddProject: () => void
    /** Open the clone-from-git flow. */
    onCloneRepo: () => void
    /** Open the settings view. */
    onOpenSettings: () => void
    /** Open the getting-started tour. */
    onShowTour: () => void
  }

  let { onNewChat, onAddProject, onCloneRepo, onOpenSettings, onShowTour }: Props = $props()

  const logoUrl = publicAssetUrl('icon-mono.svg')

  const actions = [
    {
      icon: MessageSquarePlus,
      title: 'New chat',
      description: 'Start a conversation — no project needed',
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
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-elevated transition-colors group-hover:bg-overlay"
        >
          <action.icon size={16} class="text-muted" />
        </span>
        <span class="min-w-0">
          <span class="block text-[0.8125rem] font-medium text-foreground">{action.title}</span>
          <span class="block text-[0.75rem] leading-snug text-muted">{action.description}</span>
        </span>
      </button>
    {/each}
  </div>
</div>
