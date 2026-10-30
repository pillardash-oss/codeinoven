/**
 * Live state for the Local AI page's llama.cpp servers: which rows the app started, what their
 * logs say, and whether the server actually answers.
 *
 * A row is only "running" once its `/v1/models` endpoint answers, because a
 * process that is alive but still loading a 2 GB model cannot serve a turn yet.
 * The processes themselves live in the main process's PTY service; this class
 * subscribes to their streams and never spawns anything itself.
 */
import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import {
  buildLlamaServerArgs,
  llamaCppPtyId,
  type LlamaCppProbeResult,
  type LlamaCppServerEntry
} from '$shared/llama-cpp'

export type LlamaCppServerStatus = 'stopped' | 'starting' | 'running' | 'failed'

/** One Homebrew job the Local AI page runs in its docked terminal. */
export interface BrewJob {
  kind: 'install' | 'update' | 'uninstall'
  terminalId: string
  command: string
  args: string[]
}

/** How many log lines a card keeps. */
const LOG_LINE_LIMIT = 400
/** Readiness poll cadence once a start has been requested. */
const PROBE_INTERVAL_MS = 2_000
/** A first start downloads its model, so readiness can be many minutes out. */
const PROBE_LIMIT = 900
/** A card keeps the last lines of a failure, never the whole log, in its notice. */
const FAILURE_TAIL_LINES = 6

const ANSI_PATTERN = new RegExp(
  [
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)',
    '\\u001b\\[[0-9;?]*[ -/]*[@-~]',
    '\\u001b[@-Z\\\\-_]'
  ].join('|'),
  'gu'
)

/** Terminal output without the escape sequences, so the tail reads as text. */
export function stripTerminalEscapes(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

interface RunningHandle {
  entry: LlamaCppServerEntry
  unsubscribe: Array<() => void>
  timer: ReturnType<typeof setTimeout> | null
  probes: number
  /** True between a stop request and the PTY's exit event, so the exit is not a crash. */
  stopping: boolean
  /** Partial last line, kept so a chunk boundary never splits a log line. */
  partial: string
}

export class LocalAiController {
  status = $state<Record<string, LlamaCppServerStatus>>({})
  logs = $state<Record<string, string[]>>({})
  loadedModel = $state<Record<string, string>>({})
  notice = $state<Record<string, string>>({})
  /** Called once per successful start, so the model picker can pick the model up. */
  onReady: ((entry: LlamaCppServerEntry, modelId: string) => void) | null = null

  private handles = new SvelteMap<string, RunningHandle>()

  statusOf(entryId: string): LlamaCppServerStatus {
    return this.status[entryId] ?? 'stopped'
  }

  logOf(entryId: string): string[] {
    return this.logs[entryId] ?? []
  }

  isBusy(entryId: string): boolean {
    const status = this.statusOf(entryId)
    return status === 'starting' || status === 'running'
  }

  /** Start a row, streaming its output into the card and polling for readiness. */
  async start(entry: LlamaCppServerEntry, executable: string): Promise<void> {
    if (this.handles.has(entry.id)) return
    const args = buildLlamaServerArgs(entry)
    if (args.length === 0) {
      this.setStatus(entry.id, 'failed')
      this.notice = { ...this.notice, [entry.id]: 'This server has no model to load' }
      return
    }
    const handle: RunningHandle = {
      entry,
      unsubscribe: [],
      timer: null,
      probes: 0,
      stopping: false,
      partial: ''
    }
    this.handles.set(entry.id, handle)
    this.setStatus(entry.id, 'starting')
    this.notice = { ...this.notice, [entry.id]: '' }
    this.loadedModel = { ...this.loadedModel, [entry.id]: '' }
    this.logs = { ...this.logs, [entry.id]: [] }

    const ptyId = llamaCppPtyId(entry.id)
    handle.unsubscribe.push(
      subscribe(`pty:data:${ptyId}`, (chunk) => {
        if (typeof chunk === 'string') this.appendOutput(entry.id, chunk)
      }),
      subscribe(`pty:exit:${ptyId}`, (code) => this.handleExit(entry.id, code))
    )

    try {
      await invoke('pty:createCommand', ptyId, executable, args, 120, 30)
    } catch (error) {
      this.stopHandle(entry.id)
      this.setStatus(entry.id, 'failed')
      const reason = error instanceof Error ? error.message : 'The server could not be started'
      this.notice = { ...this.notice, [entry.id]: reason }
      return
    }
    this.scheduleProbe(entry)
  }

  /**
   * Reattach to a server that is still answering, which is what a renderer
   * reload leaves behind: the main process kept the process, so the card must
   * show it as running and stay able to stop it.
   */
  async attach(entry: LlamaCppServerEntry): Promise<void> {
    // Returning to the page mid-start resumes the readiness poll instead of
    // leaving the card stuck on "starting".
    if (this.handles.has(entry.id)) {
      if (this.statusOf(entry.id) === 'starting') this.scheduleProbe(entry)
      return
    }
    const result = await invoke('llamaCpp:probe', entry.host, entry.port)
    if (!result.ready) return
    const ptyId = llamaCppPtyId(entry.id)
    const handle: RunningHandle = {
      entry,
      unsubscribe: [],
      timer: null,
      probes: 0,
      stopping: false,
      partial: ''
    }
    this.handles.set(entry.id, handle)
    handle.unsubscribe.push(
      subscribe(`pty:data:${ptyId}`, (chunk) => {
        if (typeof chunk === 'string') this.appendOutput(entry.id, chunk)
      }),
      subscribe(`pty:exit:${ptyId}`, (code) => this.handleExit(entry.id, code))
    )
    this.setStatus(entry.id, 'running')
    this.setLoadedModel(entry.id, result.models[0] ?? '')
  }

  /** Stop a server and keep its row and its log. */
  async stop(entryId: string): Promise<void> {
    const handle = this.handles.get(entryId)
    if (handle) handle.stopping = true
    await invoke('pty:destroy', llamaCppPtyId(entryId))
    this.stopHandle(entryId)
    this.setStatus(entryId, 'stopped')
    this.setLoadedModel(entryId, '')
    this.notice = { ...this.notice, [entryId]: '' }
  }

  /** Forget a row's log and status entirely, for a deleted server. */
  forget(entryId: string): void {
    void this.stop(entryId)
    const { [entryId]: _status, ...status } = this.status
    this.status = status
    const { [entryId]: _log, ...logs } = this.logs
    this.logs = logs
    const { [entryId]: _model, ...models } = this.loadedModel
    this.loadedModel = models
    const { [entryId]: _notice, ...notices } = this.notice
    this.notice = notices
  }

  /** Stop every server this page started, on the way out of the page. */
  dispose(): void {
    for (const entryId of [...this.handles.keys()]) {
      const handle = this.handles.get(entryId)
      if (handle) handle.stopping = true
      void invoke('pty:destroy', llamaCppPtyId(entryId))
      this.stopHandle(entryId)
      this.setStatus(entryId, 'stopped')
    }
  }

  private appendOutput(entryId: string, chunk: string): void {
    const handle = this.handles.get(entryId)
    if (!handle) return
    const text = (handle.partial + stripTerminalEscapes(chunk)).replaceAll('\r\n', '\n')
    const lines = text.split(/\n|\r/u)
    handle.partial = lines.pop() ?? ''
    if (lines.length === 0) return
    const current = this.logs[entryId] ?? []
    const next = [...current, ...lines].slice(-LOG_LINE_LIMIT)
    this.logs = { ...this.logs, [entryId]: next }
  }

  private handleExit(entryId: string, code: unknown): void {
    const handle = this.handles.get(entryId)
    if (!handle) return
    const stopping = handle.stopping
    const tail = this.failureTail(entryId)
    this.stopHandle(entryId)
    if (stopping) {
      this.setStatus(entryId, 'stopped')
      return
    }
    this.setStatus(entryId, 'failed')
    this.setLoadedModel(entryId, '')
    const exitCode = typeof code === 'number' ? code : 0
    this.notice = {
      ...this.notice,
      [entryId]: tail || `The server exited with code ${exitCode}`
    }
  }

  private failureTail(entryId: string): string {
    const lines = (this.logs[entryId] ?? []).filter((line) => line.trim().length > 0)
    return lines.slice(-FAILURE_TAIL_LINES).join('\n')
  }

  private scheduleProbe(entry: LlamaCppServerEntry): void {
    const handle = this.handles.get(entry.id)
    if (!handle) return
    if (handle.probes >= PROBE_LIMIT) {
      this.stopHandle(entry.id)
      void invoke('pty:destroy', llamaCppPtyId(entry.id))
      this.setStatus(entry.id, 'failed')
      this.notice = {
        ...this.notice,
        [entry.id]: this.failureTail(entry.id) || 'The server never answered on its port'
      }
      return
    }
    handle.timer = setTimeout(() => void this.probe(entry), PROBE_INTERVAL_MS)
  }

  private async probe(entry: LlamaCppServerEntry): Promise<void> {
    const handle = this.handles.get(entry.id)
    if (!handle) return
    handle.probes++
    let result: LlamaCppProbeResult
    try {
      result = await invoke('llamaCpp:probe', entry.host, entry.port)
    } catch {
      result = { ready: false, models: [], error: 'The readiness probe failed' }
    }
    if (!this.handles.has(entry.id)) return
    if (result.ready) {
      handle.timer = null
      this.setStatus(entry.id, 'running')
      this.setLoadedModel(entry.id, result.models[0] ?? '')
      this.notice = { ...this.notice, [entry.id]: '' }
      this.onReady?.(entry, result.models[0] ?? '')
      return
    }
    this.scheduleProbe(entry)
  }

  private stopHandle(entryId: string): void {
    const handle = this.handles.get(entryId)
    if (!handle) return
    for (const unsubscribe of handle.unsubscribe) unsubscribe()
    if (handle.timer) clearTimeout(handle.timer)
    this.handles.delete(entryId)
  }

  private setStatus(entryId: string, status: LlamaCppServerStatus): void {
    this.status = { ...this.status, [entryId]: status }
  }

  private setLoadedModel(entryId: string, modelId: string): void {
    this.loadedModel = { ...this.loadedModel, [entryId]: modelId }
  }
}

export const localAi = new LocalAiController()
