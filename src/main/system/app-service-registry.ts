import { randomUUID } from 'node:crypto'

/**
 * Kind of app-owned runtime the task manager lists.
 *
 * `server` is an in-process loopback listener with no child process (the
 * prototype preview server, a previewed folder's static host, the utility
 * gateway). `mcp` is a stdio MCP server a turn or a long-lived service started.
 * `gateway` is a supervised local model gateway. `worker` is any other
 * app-owned long-lived helper.
 */
export type AppServiceKind = 'server' | 'mcp' | 'gateway' | 'worker'

/** Owner of a registered service; `app` means it belongs to no single thread. */
export type AppServiceScope = 'app' | 'project' | 'thread'

/** What a caller hands the registry. `id` is optional for one-shot services. */
export interface AppServiceRegistration {
  id?: string
  kind: AppServiceKind
  /** Short, specific label shown as the row title. */
  name: string
  /** Supporting line: a URL, command line, or folder. */
  detail?: string | null
  scope?: AppServiceScope
  projectId?: string | null
  threadId?: string | null
  /** OS pid when the service is backed by a child process. */
  pid?: number | null
  /** Loopback port the service is listening on, when it listens. */
  port?: number | null
  /** Origin URL a user can open, when the service serves HTTP. */
  url?: string | null
  /**
   * Stops the service from the task manager. Omit for a runtime the app owns for
   * its whole lifetime (the utility gateway, the shared prototype preview
   * server), so the UI never offers a stop it cannot honour.
   */
  stop?: () => void | Promise<void>
}

/** Serializable service row, safe to cross IPC. */
export interface AppServiceSnapshot {
  id: string
  kind: AppServiceKind
  name: string
  detail: string | null
  scope: AppServiceScope
  projectId: string | null
  threadId: string | null
  pid: number | null
  port: number | null
  url: string | null
  startedAt: number
  stoppable: boolean
}

interface RegisteredService {
  snapshot: AppServiceSnapshot
  stop?: () => void | Promise<void>
}

const MAX_SERVICES = 512

/**
 * Single main-process ledger of every long-lived runtime the app owns.
 *
 * `AgentProcessService` only sees operating-system processes, so anything that
 * lives inside the Electron process (a loopback HTTP server) or that is spawned
 * outside its tracking (an MCP child) is invisible to the task manager. This
 * registry is where those runtimes announce themselves, so the snapshot the task
 * manager reads is the app's actual surface rather than a guess.
 *
 * Registration is idempotent per `id`: registering an existing id replaces its
 * row and its stop action, which lets a service re-announce itself after a
 * restart without leaking duplicate rows.
 */
export class AppServiceRegistry {
  private readonly entries = new Map<string, RegisteredService>()

  /** Register or replace one service; returns the id it was stored under. */
  register(registration: AppServiceRegistration): string {
    const id = registration.id?.trim() || randomUUID()
    const snapshot: AppServiceSnapshot = {
      id,
      kind: registration.kind,
      name: registration.name,
      detail: registration.detail ?? null,
      scope: registration.scope ?? 'app',
      projectId: registration.projectId ?? null,
      threadId: registration.threadId ?? null,
      pid: registration.pid ?? null,
      port: registration.port ?? null,
      url: registration.url ?? null,
      startedAt: Date.now(),
      stoppable: typeof registration.stop === 'function'
    }
    const existing = this.entries.get(id)
    // A re-registration keeps the original start time so uptime does not reset
    // just because a caller re-announced a runtime that never went away.
    if (existing) snapshot.startedAt = existing.snapshot.startedAt
    this.entries.delete(id)
    this.entries.set(id, {
      snapshot,
      ...(registration.stop ? { stop: registration.stop } : {})
    })
    while (this.entries.size > MAX_SERVICES) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
    return id
  }

  /** Drop a service that stopped, exited, or was disposed. */
  unregister(id: string): void {
    this.entries.delete(id)
  }

  /** Every registered service, oldest first. */
  list(): AppServiceSnapshot[] {
    return [...this.entries.values()]
      .map((entry) => entry.snapshot)
      .sort((left, right) => left.startedAt - right.startedAt)
  }

  /** Stop one service through the action it registered with. */
  async stop(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Service ${id} is not running`)
    if (!entry.stop) throw new Error(`Service ${entry.snapshot.name} cannot be stopped here`)
    await entry.stop()
  }
}

/** The app's single service registry. */
export const appServiceRegistry = new AppServiceRegistry()
