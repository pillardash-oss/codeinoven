<script lang="ts">
  import { onMount } from 'svelte'
  import CloudRemoteAccess from '$lib/components/remote/CloudRemoteAccess.svelte'
  import RemoteMobileShell from '$lib/components/remote/RemoteMobileShell.svelte'
  import { remoteSession } from '$lib/remote/session-store.svelte'
  import { clearPreferredDesktop } from '$lib/remote/preferred-desktop'
  import { invoke } from '$lib/ipc.svelte'
  import { applyTheme, resolveTheme, watchSystemDark } from '$lib/theme'
  import Toaster from '$lib/components/ui/Toaster.svelte'
  import { mobileState } from '$lib/remote/mobile-state.svelte'

  let connected = $derived(
    remoteSession.snapshot.route.kind === 'LAN_CONNECTED' ||
      remoteSession.snapshot.route.kind === 'RELAY_CONNECTED'
  )
  let workspaceOpened = $state(false)
  let workspaceActive = $derived(workspaceOpened && (connected || remoteSession.recovering))

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

  onMount(() => {
    const stopWatching = watchSystemDark((dark) => {
      systemDark = dark
      applyCurrentTheme()
    })
    applyCurrentTheme()
    const syncVisibility = (): void => {
      if (document.visibilityState === 'visible') void remoteSession.resume()
      else remoteSession.suspend()
    }
    const suspend = (): void => remoteSession.suspend()
    const resume = (): void => void remoteSession.resume()
    let wasConnected = connected
    const stopStateWatch = remoteSession.onStateChange((snapshot) => {
      const isConnectedNow =
        snapshot.route.kind === 'LAN_CONNECTED' || snapshot.route.kind === 'RELAY_CONNECTED'
      if (isConnectedNow && !wasConnected && workspaceOpened) {
        void remoteSession.setWorkspaceActive(true).catch(() => undefined)
        void mobileState.reconcileAfterReconnect()
      }
      wasConnected = isConnectedNow
    })
    document.addEventListener('visibilitychange', syncVisibility)
    window.addEventListener('pagehide', suspend)
    window.addEventListener('pageshow', resume)
    return () => {
      stopWatching()
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
      class="fixed left-1/2 top-[max(1rem,env(safe-area-inset-top))] z-60 -translate-x-1/2 rounded-full border border-border bg-surface px-4 py-2 text-xs font-medium text-muted shadow-xl"
      role="status"
      aria-live="polite"
    >
      Restoring desktop connection…
    </div>
  {/if}
{:else}
  <CloudRemoteAccess onOpenWorkspace={openWorkspace} />
{/if}

<Toaster />
