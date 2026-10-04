<script lang="ts">
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import {
    preloadSettingsChunk,
    preloadTaskManagerChunk,
    preloadUpdateBlockersChunk
  } from '$lib/page-preload'
  import { isSettingsView, type MainView } from '$lib/stores/renderer-recovery.svelte'
  import { updateBlockers } from '$lib/stores/update-blockers.svelte'
  import { updaterState } from '$lib/stores/updater.svelte'
  import {
    AlertCircle,
    CheckCircle2,
    Clock,
    CpuIcon,
    Download,
    Info,
    Loader2,
    Plug,
    RefreshCw,
    Settings
  } from '@lucide/svelte'
  import type { Component } from 'svelte'
  import AppRailButton from './AppRailButton.svelte'

  interface Props {
    navigate: (view: MainView) => void
    /** The view the shell shows, so Settings can mark itself as current. */
    activeView: MainView
  }

  let { navigate, activeView }: Props = $props()

  let taskManagerOpen = $state(false)
  let blockersModalOpen = $state(false)

  /** One shape for the update control's icon, label, tone and enabled state. */
  interface UpdateControl {
    icon: Component
    label: string
    tone: 'default' | 'primary' | 'danger' | 'accent'
    disabled: boolean
    spin: boolean
  }

  const settingsShortcut = $derived(keymapState.keysFor('nav-settings'))
  const taskManagerShortcut = $derived(keymapState.keysFor('nav-task-manager'))

  const updateControl = $derived.by((): UpdateControl => {
    const status = updaterState.status
    if (!status.canAutoUpdate) {
      return {
        icon: Info,
        label: 'Application and update information',
        tone: 'default',
        disabled: false,
        spin: false
      }
    }
    switch (status.state) {
      case 'checking':
        return {
          icon: Loader2,
          label: 'Checking for updates',
          tone: 'default',
          disabled: true,
          spin: true
        }
      case 'available':
        return {
          icon: Download,
          label: `Update ${status.availableVersion} available. Download`,
          tone: 'primary',
          disabled: false,
          spin: false
        }
      case 'downloading':
        return {
          icon: Loader2,
          label: `Downloading update. ${status.downloadProgress}%`,
          tone: 'default',
          disabled: true,
          spin: true
        }
      case 'downloaded':
        return {
          icon: RefreshCw,
          label: 'Update ready. Restart and install',
          tone: 'primary',
          disabled: false,
          spin: false
        }
      case 'waiting':
        return {
          icon: Clock,
          // Enabled, not disabled: waiting is not a dead end. The click opens
          // the modal that names the work and offers the force install, which is
          // the only escape when a session is stuck reporting itself as working.
          label: `Update waiting for ${updaterState.waitingForThreads} active thread${
            updaterState.waitingForThreads === 1 ? '' : 's'
          } to finish. Review and force install`,
          tone: 'accent',
          disabled: false,
          spin: false
        }
      case 'error':
        return {
          icon: AlertCircle,
          label: `Update error: ${status.errorMessage}`,
          tone: 'danger',
          disabled: false,
          spin: false
        }
      default:
        return {
          icon: CheckCircle2,
          label: 'Application is up to date',
          tone: 'default',
          disabled: false,
          spin: false
        }
    }
  })

  /** The update tool acts, or opens About when there is nothing to run. */
  function onUpdateSelect(): void {
    const status = updaterState.status
    if (status.canAutoUpdate && status.state === 'available') {
      void updaterState.downloadUpdate()
      return
    }
    if (status.canAutoUpdate && status.state === 'downloaded') {
      void updaterState.installUpdate()
      return
    }
    if (status.canAutoUpdate && status.state === 'waiting') {
      // Read the blockers first so the modal opens with the list already in it.
      // Nothing is mounted until this resolves, so there is no empty frame.
      void openBlockersModal()
      return
    }
    navigate('settings-about')
  }

  /**
   * Warm whichever chunk this button's click will open.
   *
   * The button is one control with two destinations, so a fixed hover warmer
   * would fetch Settings for a click that opens the modal instead. The state
   * decides, read at hover time rather than captured, so the button warms the
   * right chunk even when the gate opens while the mouse is already on it.
   */
  function onUpdateHover(): void {
    if (updaterState.status.canAutoUpdate && updaterState.status.state === 'waiting') {
      preloadUpdateBlockersChunk()
      return
    }
    preloadSettingsChunk()
  }

  /**
   * Load the blockers, then show the modal over whatever the user was doing.
   *
   * `prepare` decides whether there is anything to show, so a click that raced the
   * gate opening on its own leaves the window alone instead of putting a
   * destructive action on screen for work that has already finished.
   */
  async function openBlockersModal(): Promise<void> {
    if (await updateBlockers.prepare()) blockersModalOpen = true
  }

  /**
   * The Task Manager's chord. The rail owns the surface and its open flag, so
   * its shortcut lives here with them instead of in the header's view table;
   * the trigger itself still comes from the keymap registry. Reopening an open
   * surface is a no-op, and the chunk is warmed first so a cold open does not
   * pay the module fetch on the chord.
   */
  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.repeat || event.isComposing) return
    if (!keymapState.matches('nav-task-manager', event)) return
    event.preventDefault()
    preloadTaskManagerChunk()
    taskManagerOpen = true
  }
</script>

<!--
  The rail's utility group, anchored to the bottom edge. These are the same
  three controls the project sidebar footer used to hold (update status, task
  manager, settings), moved here so they stay reachable on every view and while
  the sidebar is collapsed.
-->
<svelte:window onkeydown={handleWindowKeydown} />

<div class="mt-auto flex flex-col items-center gap-0.5">
  <AppRailButton
    label={updateControl.label}
    icon={updateControl.icon}
    tone={updateControl.tone}
    disabled={updateControl.disabled}
    spin={updateControl.spin}
    onHover={onUpdateHover}
    onSelect={onUpdateSelect}
  />

  <AppRailButton
    label="Task manager: running processes"
    icon={CpuIcon}
    shortcut={taskManagerShortcut}
    onHover={preloadTaskManagerChunk}
    onSelect={() => (taskManagerOpen = true)}
  />

  <AppRailButton
    label="Utilities: Skills, MCP, Plugins"
    icon={Plug}
    shortcut={settingsShortcut}
    onHover={preloadSettingsChunk}
    onSelect={() => navigate('settings-utilities')}
  />

  <AppRailButton
    label="Settings"
    icon={Settings}
    active={isSettingsView(activeView)}
    shortcut={settingsShortcut}
    onHover={preloadSettingsChunk}
    onSelect={() => navigate('settings')}
  />
</div>

<!-- The process list is a secondary surface behind one rail button, so its
     module stays out of the first-paint chunk: the button's hover warms it
     (`preloadTaskManagerChunk`) and the mount below only happens once it is
     actually open. The modal renders nothing while closed, so gating on the
     open flag mounts the same surface, just later. -->
{#if taskManagerOpen}
  {#await import('$lib/components/workspace/TaskManagerModal.svelte') then { default: TaskManagerModal }}
    <TaskManagerModal open={taskManagerOpen} onClose={() => (taskManagerOpen = false)} />
  {/await}
{/if}

<!-- Same treatment as the task manager above: the force-install modal is reached
     from one rail button, so it stays out of the first-paint chunk and mounts
     only once the click has also loaded the list it renders. -->
{#if blockersModalOpen}
  {#await import('$lib/components/layout/UpdateBlockersModal.svelte') then { default: UpdateBlockersModal }}
    <UpdateBlockersModal
      payload={updateBlockers.payload}
      onDismiss={() => {
        blockersModalOpen = false
        updateBlockers.close()
      }}
    />
  {/await}
{/if}
