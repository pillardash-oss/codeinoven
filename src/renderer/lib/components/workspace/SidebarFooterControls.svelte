<script lang="ts">
  import {
    AlertCircle,
    CheckCircle2,
    Clock,
    Download,
    Info,
    Loader2,
    Plug,
    RefreshCw,
    Settings
  } from '@lucide/svelte'
  import { keymapKeys } from '$lib/keymap/keymap'
  import { preloadSettingsChunk } from '$lib/page-preload'
  import { updaterState } from '$lib/stores/updater.svelte'
  import type { MainView } from '$lib/stores/renderer-recovery.svelte'
  import TaskManagerModal from './TaskManagerModal.svelte'

  interface Props {
    navigate: (view: MainView) => void
  }

  let { navigate }: Props = $props()

  let taskManagerOpen = $state(false)
</script>

<div class="flex items-center gap-1 px-2 py-1.5">
  <button
    type="button"
    class="flex h-8 flex-1 items-center gap-2 rounded-lg px-2 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
    title="Open settings"
    data-shortcut={keymapKeys('nav-settings').join(',')}
    onmouseenter={preloadSettingsChunk}
    onclick={() => navigate('settings')}
  >
    <Settings size={14} />
    Settings
  </button>

  <div class="ml-auto flex shrink-0 items-center gap-1">
    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Task manager   running processes"
      aria-label="Open the task manager"
      onclick={() => (taskManagerOpen = true)}
    >
      <Plug size={14} />
    </button>
    {#if !updaterState.status.canAutoUpdate}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Application and update information"
        aria-label="Open application and update information"
        onmouseenter={preloadSettingsChunk}
        onclick={() => navigate('settings-about')}
      >
        <Info size={14} />
      </button>
    {:else if updaterState.status.state === 'checking'}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-dimmed"
        disabled
        title="Checking for updates"
        aria-label="Checking for updates"
      >
        <Loader2 size={14} class="animate-spin" />
      </button>
    {:else if updaterState.status.state === 'available'}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-primary transition-colors hover:bg-elevated"
        title="Update {updaterState.status.availableVersion} available   download"
        aria-label="Download update {updaterState.status.availableVersion}"
        onclick={() => void updaterState.downloadUpdate()}
      >
        <Download size={14} />
      </button>
    {:else if updaterState.status.state === 'downloading'}
      <button
        type="button"
        class="flex h-8 items-center gap-1 rounded-lg px-1.5 text-[0.6875rem] text-muted"
        disabled
        title="Downloading update   {updaterState.status.downloadProgress}%"
        aria-label="Downloading update   {updaterState.status.downloadProgress}%"
      >
        <Loader2 size={13} class="animate-spin" />
        <span class="tabular-nums">{updaterState.status.downloadProgress}%</span>
      </button>
    {:else if updaterState.status.state === 'downloaded'}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-primary transition-colors hover:bg-elevated"
        title="Update ready   restart and install"
        aria-label="Restart and install update"
        onclick={() => void updaterState.installUpdate()}
      >
        <RefreshCw size={14} />
      </button>
    {:else if updaterState.status.state === 'waiting'}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-accent"
        disabled
        title="Waiting for {updaterState.waitingForThreads} active thread{updaterState.waitingForThreads !==
        1
          ? 's'
          : ''} to finish"
        aria-label="Update waiting for active threads to finish"
      >
        <Clock size={14} />
      </button>
    {:else if updaterState.status.state === 'error'}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-danger transition-colors hover:bg-elevated"
        title="Update error: {updaterState.status.errorMessage}"
        aria-label="Open update error details"
        onmouseenter={preloadSettingsChunk}
        onclick={() => navigate('settings-about')}
      >
        <AlertCircle size={14} />
      </button>
    {:else}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Application is up to date"
        aria-label="Open application and update information"
        onmouseenter={preloadSettingsChunk}
        onclick={() => navigate('settings-about')}
      >
        <CheckCircle2 size={14} />
      </button>
    {/if}
  </div>
</div>

<TaskManagerModal open={taskManagerOpen} onClose={() => (taskManagerOpen = false)} />
