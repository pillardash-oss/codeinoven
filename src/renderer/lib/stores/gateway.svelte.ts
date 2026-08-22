import { invoke, subscribe } from '$lib/ipc.svelte'
import { contextSidebarState } from './context-sidebar.svelte'
import { workspaceState } from './workspace.svelte'
import type { GatewayStatus } from '$shared/gateway-types'

class GatewayState {
  statuses = $state<GatewayStatus[]>([])
  loading = $state(false)
  private initialized = false
  private unsubscribe: (() => void) | null = null

  get readyGateways(): GatewayStatus[] {
    return this.statuses.filter((g) => g.lifecycle === 'ready' && g.dashboardUrl)
  }

  get primaryReadyGateway(): GatewayStatus | null {
    return this.readyGateways[0] ?? null
  }

  get hasReadyGateway(): boolean {
    return this.readyGateways.length > 0
  }

  get dashboardUrl(): string | null {
    return this.primaryReadyGateway?.dashboardUrl ?? null
  }

  async refresh(): Promise<void> {
    this.loading = true
    try {
      this.statuses = await invoke('gateway:list')
    } catch {
      // Gateway not available yet — keep existing state
    } finally {
      this.loading = false
    }
  }

  /** Ensure the store is subscribed to live gateway state */
  ensureSubscribed(): void {
    if (this.initialized) return
    this.initialized = true
    void this.refresh()
    this.unsubscribe = subscribe('gateway:state', (status) => {
      const idx = this.statuses.findIndex((g) => g.pluginId === status.pluginId)
      if (idx === -1) this.statuses = [...this.statuses, status]
      else this.statuses = this.statuses.map((g) => (g.pluginId === status.pluginId ? status : g))
    })
  }

  /**
   * Open the gateway dashboard in the global (embedded) browser.
   * Always forces CIO browser regardless of user preference, since
   * gateway is loopback-only and must stay inside the app.
   * When there is no active thread we reuse the last known
   * project/thread context so the dashboard still opens inside
   * the embedded browser (global access via header).
   */
  async openDashboard(url?: string | null): Promise<boolean> {
    const target = url ?? this.dashboardUrl
    if (!target) return false
    // Preferred: active thread context (shows in current project)
    const direct = contextSidebarState.openBrowser(target)
    if (direct !== null) return true

    // Fallback: reuse workspace's last known project/thread so
    // the header button works even from Settings with no selection
    const fallbackProject = workspaceState.activeProject
    const fallbackThread = workspaceState.selectedThread
    if (fallbackProject && fallbackThread) {
      try {
        contextSidebarState.openBrowserForContext(
          target,
          fallbackProject.id,
          fallbackThread.id,
          undefined,
          true
        )
        return true
      } catch {
        // fall through to external
      }
    }
    // Try any recent thread visit as anchor
    const recent = workspaceState.recentThreadVisits[0]
    if (recent) {
      const [projectId, ...rest] = recent.split(':')
      const threadId = rest.join(':')
      if (projectId && threadId) {
        try {
          contextSidebarState.openBrowserForContext(target, projectId, threadId, undefined, true)
          return true
        } catch {
          // fall through
        }
      }
    }
    try {
      await invoke('shell:openExternal', target)
      return true
    } catch {
      return false
    }
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.initialized = false
  }
}

export const gatewayState = new GatewayState()
