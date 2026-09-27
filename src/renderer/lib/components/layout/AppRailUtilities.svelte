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
  import type { Component } from 'svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { preloadSettingsChunk } from '$lib/page-preload'
  import { updaterState } from '$lib/stores/updater.svelte'
  import { isSettingsView, type MainView } from '$lib/stores/renderer-recovery.svelte'
  import TaskManagerModal from '$lib/components/workspace/TaskManagerModal.svelte'
  import AppRailButton from './AppRailButton.svelte'

  interface Props {
    navigate: (view: MainView) => void
    /** The view the shell shows, so Settings can mark itself as current. */
    activeView: MainView
  }

  let { navigate, activeView }: Props = $props()

  let taskManagerOpen = $state(false)

  /** One shape for the update control's icon, label, tone and enabled state. */
  interface UpdateControl {
    icon: Component
    label: string
    tone: 'default' | 'primary' | 'danger' | 'accent'
    disabled: boolean
    spin: boolean
  }

  const settingsShortcut = $derived(keymapState.keysFor('nav-settings'))

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
          label: `Update waiting for ${updaterState.waitingForThreads} active thread${
            updaterState.waitingForThreads === 1 ? '' : 's'
          } to finish`,
          tone: 'accent',
          disabled: true,
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
    navigate('settings-about')
  }
</script>

<!--
  The rail's utility group, anchored to the bottom edge. These are the same
  three controls the project sidebar footer used to hold (update status, task
  manager, settings), moved here so they stay reachable on every view and while
  the sidebar is collapsed.
-->
<div class="mt-auto flex flex-col items-center gap-0.5">
  <AppRailButton
    label={updateControl.label}
    icon={updateControl.icon}
    tone={updateControl.tone}
    disabled={updateControl.disabled}
    spin={updateControl.spin}
    onHover={preloadSettingsChunk}
    onSelect={onUpdateSelect}
  />

  <AppRailButton
    label="Task manager: running processes"
    icon={Plug}
    onSelect={() => (taskManagerOpen = true)}
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

<TaskManagerModal open={taskManagerOpen} onClose={() => (taskManagerOpen = false)} />
