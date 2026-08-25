<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteURLSearchParams } from 'svelte/reactivity'
  import CloudRemoteAccess from '$lib/components/remote/CloudRemoteAccess.svelte'
  import RemoteMobileShell from '$lib/components/remote/RemoteMobileShell.svelte'
  import { remoteSession } from '$lib/remote/session-store.svelte'
  import { clearPreferredDesktop } from '$lib/remote/preferred-desktop'
  import { invoke } from '$lib/ipc.svelte'
  import { applyTheme, resolveTheme, watchSystemDark } from '$lib/theme'
  import Toaster from '$lib/components/ui/Toaster.svelte'
  import { mobileState } from '$lib/remote/mobile-state.svelte'
  import { mobileNotifications } from '$lib/remote/mobile-notifications.svelte'

  const NOTIFICATION_PROJECT_PARAM = 'notificationProject'
  const NOTIFICATION_THREAD_PARAM = 'notificationThread'

  interface NotificationOpenTarget {
    projectId: string
    threadId: string
  }

  let connected = $derived(
    remoteSession.snapshot.route.kind === 'LAN_CONNECTED' ||
      remoteSession.snapshot.route.kind === 'RELAY_CONNECTED'
  )
  let workspaceOpened = $state(false)
  // A transport route is transient; the user's workspace is not. Keep the
  // shell mounted across LAN probes, relay authentication, and background
  // resume. Only the explicit disconnect action closes it.
  let workspaceActive = $derived(workspaceOpened)

  // The desktop shell applies the theme from its own root component, which the
  // phone never mounts. Without this the client is stuck in light mode.
  let systemDark = $state(false)
  let preference = $state<'system' | 'light' | 'dark'>('system')

  function applyCurrentTheme(): void {
    applyTheme(resolveTheme(preference, systemDark))
  }

  /** The desktop's configured theme only becomes readable once the bridge is
   *  live; until then the phone's own colour scheme is the best approximation. */
  function syncDesktopTheme(): void {
    void invoke('config:get')
      .then((config) => {
        preference = config.theme
        applyCurrentTheme()
      })
      .catch(() => applyCurrentTheme())
  }

  async function disconnectDesktop(): Promise<void> {
    workspaceOpened = false
    try {
      await remoteSession.setWorkspaceActive(false)
    } catch {
      // Disconnecting the transport below also clears desktop workspace activity.
    } finally {
      clearPreferredDesktop()
      remoteSession.disconnect()
    }
  }

  function openWorkspace(): void {
    if (!connected) return
    workspaceOpened = true
    void remoteSession.setWorkspaceActive(true).catch(() => undefined)
  }

  function consumeNotificationTarget(): NotificationOpenTarget | null {
    const params = new SvelteURLSearchParams(location.hash.replace(/^#/u, ''))
    const projectId = params.get(NOTIFICATION_PROJECT_PARAM)
    const threadId = params.get(NOTIFICATION_THREAD_PARAM)
    if (!projectId || !threadId) return null

    params.delete(NOTIFICATION_PROJECT_PARAM)
    params.delete(NOTIFICATION_THREAD_PARAM)
    const remainingHash = params.toString()
    history.replaceState(
      history.state,
      '',
      `${location.pathname}${location.search}${remainingHash ? `#${remainingHash}` : ''}`
    )
    return { projectId, threadId }
  }

  onMount(() => {
    let openWorkspaceWhenConnected = false
    const routeNotification = (projectId: string, threadId: string): void => {
      mobileNotifications.routeOpen(projectId, threadId)
      if (connected) {
        openWorkspace()
        openWorkspaceWhenConnected = false
      } else {
        openWorkspaceWhenConnected = true
      }
    }
    const onServiceWorkerMessage = (event: MessageEvent): void => {
      const record = event.data
      if (record?.type === 'notification:open' && record.projectId && record.threadId) {
        routeNotification(String(record.projectId), String(record.threadId))
      }
    }
    const stopWatching = watchSystemDark((dark) => {
      systemDark = dark
      applyCurrentTheme()
    })
    applyCurrentTheme()
    const syncVisibility = (): void => {
      if (document.visibilityState === 'visible') void remoteSession.resume().catch(() => undefined)
      else remoteSession.suspend()
    }
    const suspend = (): void => remoteSession.suspend()
    const resume = (): void => {
      void remoteSession.resume().catch(() => undefined)
    }
    let wasConnected = connected
    const stopStateWatch = remoteSession.onStateChange((snapshot) => {
      const isConnectedNow =
        snapshot.route.kind === 'LAN_CONNECTED' || snapshot.route.kind === 'RELAY_CONNECTED'
      if (isConnectedNow && !wasConnected && workspaceOpened) {
        void remoteSession.setWorkspaceActive(true).catch(() => undefined)
        void mobileState.reconcileAfterReconnect()
      }
      if (isConnectedNow && openWorkspaceWhenConnected) {
        openWorkspaceWhenConnected = false
        openWorkspace()
      }
      wasConnected = isConnectedNow
    })
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage)
    document.addEventListener('visibilitychange', syncVisibility)
    window.addEventListener('pagehide', suspend)
    window.addEventListener('pageshow', resume)
    const notificationTarget = consumeNotificationTarget()
    if (notificationTarget) {
      routeNotification(notificationTarget.projectId, notificationTarget.threadId)
    }
    syncVisibility()
    return () => {
      stopWatching()
      navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage)
      document.removeEventListener('visibilitychange', syncVisibility)
      window.removeEventListener('pagehide', suspend)
      window.removeEventListener('pageshow', resume)
      stopStateWatch()
    }
  })
</script>

{#if workspaceActive}
  <RemoteMobileShell onDisconnect={disconnectDesktop} onConnected={syncDesktopTheme} />
  {#if remoteSession.recovering}
    <div
      class="pointer-events-none fixed left-1/2 z-60 -translate-x-1/2 whitespace-nowrap rounded-full border border-border/60 bg-surface/70 px-4 py-1.5 text-xs font-medium text-muted backdrop-blur-md"
      style="top: calc(env(safe-area-inset-top) + 5.875rem)"
      role="status"
      aria-live="polite"
    >
      Restoring connection
    </div>
  {/if}
{:else}
  <CloudRemoteAccess onOpenWorkspace={openWorkspace} />
{/if}

<Toaster />
