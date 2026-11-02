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
  llamaCppModelAlias,
  llamaCppPtyId,
  type LlamaCppBrewJobKind,
  type LlamaCppLogStream,
  type LlamaCppProbeResult,
  type LlamaCppServerEntry
} from '$shared/llama-cpp'

export type LlamaCppServerStatus = 'stopped' | 'starting' | 'running' | 'failed'

/** One Homebrew job the Local AI page runs in its docked terminal. */
export interface BrewJob {
  kind: LlamaCppBrewJobKind
  terminalId: string
  command: string
  args: string[]
  /** Homebrew settings the job needs, so it never waits for a keypress. */
  environment: Record<string, string>
}

/** How many log lines a card keeps. */
const LOG_LINE_LIMIT = 400
/** Readiness poll cadence once a start has been requested. */
const PROBE_INTERVAL_MS = 2_000
/** A first start downloads its model, so readiness can be many minutes out. */
const PROBE_LIMIT = 900
/** A card keeps the last lines of a failure, never the whole log, in its notice. */
const FAILURE_TAIL_LINES = 6
/** An adopted server is watched for as long as it runs, since nothing else tells
 *  the app when it exits. */
const ADOPTED_PROBE_MS = 5_000

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
  /** True when the server was already running and this page only found it, so
   *  there is no PTY of ours behind it and stopping means ending its process. */
  adopted: boolean
  /** True when the row's log is read from its own file rather than a live PTY. */
  following: boolean
  /** Partial last line, kept so a chunk boundary never splits a log line. */
  partial: string
}

export class LocalAiController {
  status = $state<Record<string, LlamaCppServerStatus>>({})
  logs = $state<Record<string, string[]>>({})
  loadedModel = $state<Record<string, string>>({})
  notice = $state<Record<string, string>>({})
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

  /** A start waiting for the user to accept that the model already bound to
   *  that address is stopped first, since one port serves one model at a time. */
  pendingTakeover = $state<{
    entry: LlamaCppServerEntry
    executable: string
    otherModel: string
  } | null>(null)

  /**
   * Start a row.
   *
   * A server already answering on that address is reused when it serves this
   * row's model, whatever app instance launched it. When it serves a different
   * model, the port cannot hold both, so the start waits for the user to agree
   * to stopping the one that is there.
   */
  async start(entry: LlamaCppServerEntry, executable: string): Promise<void> {
    if (this.handles.has(entry.id)) return
    const ready = await this.probeOf(entry)
    if (ready.ready && this.servesEntry(entry, ready.models)) {
      await this.adopt(entry, ready.models[0] ?? '')
      return
    }
    if (ready.ready) {
      this.pendingTakeover = { entry, executable, otherModel: ready.models[0] ?? 'Another model' }
      return
    }
    await this.spawn(entry, executable)
  }

  /** The user agreed: stop what holds the address, then start this row. */
  async confirmTakeover(): Promise<void> {
    const pending = this.pendingTakeover
    if (!pending) return
    this.pendingTakeover = null
    for (const [entryId, handle] of [...this.handles]) {
      if (handle.entry.port !== pending.entry.port) continue
      await this.stop(entryId)
    }
    // Anything else on the port (a server of an earlier app instance) has no
    // handle of ours to stop through.
    await invoke('llamaCpp:stopServer', pending.entry.port)
    await this.spawn(pending.entry, pending.executable)
  }

  cancelTakeover(): void {
    this.pendingTakeover = null
  }

  /** Whether a row's own model is among the ids a server answers with. */
  private servesEntry(entry: LlamaCppServerEntry, models: readonly string[]): boolean {
    const alias = llamaCppModelAlias(entry)
    return models.some((model) => model === alias)
  }

  private async probeOf(entry: LlamaCppServerEntry): Promise<LlamaCppProbeResult> {
    try {
      return await invoke('llamaCpp:probe', entry.host, entry.port)
    } catch {
      return { ready: false, models: [], error: 'The readiness probe failed' }
    }
  }

  /** Launch the row in a terminal, streaming its output into the card. */
  private async spawn(entry: LlamaCppServerEntry, executable: string): Promise<void> {
    const args = buildLlamaServerArgs(entry, await this.logPathOf(entry.id))
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
      adopted: false,
      following: false,
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
    const ready = await this.probeOf(entry)
    if (ready.ready && this.servesEntry(entry, ready.models)) {
      await this.adopt(entry, ready.models[0] ?? '')
      return
    }
    // Nothing of this row is answering, so show what the last run left in its
    // log file instead of an empty terminal.
    await this.seedLog(entry.id)
  }

  /** Take over a server that is already answering this row's model. */
  private async adopt(entry: LlamaCppServerEntry, modelId: string): Promise<void> {
    if (this.handles.has(entry.id)) return
    const ptyId = llamaCppPtyId(entry.id)
    const handle: RunningHandle = {
      entry,
      unsubscribe: [],
      timer: null,
      probes: 0,
      stopping: false,
      adopted: true,
      following: false,
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
    this.setLoadedModel(entry.id, modelId)
    this.notice = { ...this.notice, [entry.id]: '' }
    // The PTY that carried this server's output may be gone with the app
    // instance that launched it; its own log file is what streams instead.
    await this.followLog(entry)
    this.scheduleAdoptedProbe(entry)
  }

  /** No PTY exit event will come for an adopted server, so a slow probe is what
   *  notices that it died. */
  private scheduleAdoptedProbe(entry: LlamaCppServerEntry): void {
    const handle = this.handles.get(entry.id)
    if (!handle || handle.stopping) return
    handle.timer = setTimeout(() => void this.probeAdopted(entry), ADOPTED_PROBE_MS)
  }

  private async probeAdopted(entry: LlamaCppServerEntry): Promise<void> {
    if (!this.handles.has(entry.id)) return
    let ready: boolean
    try {
      ready = (await invoke('llamaCpp:probe', entry.host, entry.port)).ready
    } catch {
      ready = false
    }
    if (!this.handles.has(entry.id)) return
    if (ready) {
      this.scheduleAdoptedProbe(entry)
      return
    }
    this.stopHandle(entry.id)
    this.setStatus(entry.id, 'failed')
    this.setLoadedModel(entry.id, '')
    this.notice = { ...this.notice, [entry.id]: 'The server stopped answering on its port' }
  }

  /** The log file a row's server writes, empty when main refuses the id. */
  private async logPathOf(entryId: string): Promise<string | undefined> {
    try {
      return await invoke('llamaCpp:logPath', entryId)
    } catch {
      return undefined
    }
  }

  /** Show what a row's log file already holds, without following it. */
  private async seedLog(entryId: string): Promise<void> {
    if ((this.logs[entryId] ?? []).length > 0) return
    try {
      const lines = await invoke('llamaCpp:logTail', entryId)
      if (lines.length === 0 || this.handles.has(entryId)) return
      this.logs = { ...this.logs, [entryId]: lines.slice(-LOG_LINE_LIMIT) }
    } catch {
      // A row with no log file keeps the empty state.
    }
  }

  /**
   * Ask main where this row's log comes from. A live PTY keeps streaming on its
   * own channels; otherwise the server's log file is followed, which is the only
   * source left for a process the app did not start in this instance.
   */
  private async followLog(entry: LlamaCppServerEntry): Promise<void> {
    const handle = this.handles.get(entry.id)
    if (!handle) return
    let stream: LlamaCppLogStream
    try {
      stream = await invoke('llamaCpp:logStream', entry.id, true)
    } catch {
      return
    }
    if (!this.handles.has(entry.id)) return
    if (stream.lines.length > 0 && (this.logs[entry.id] ?? []).length === 0) {
      this.logs = { ...this.logs, [entry.id]: stream.lines.slice(-LOG_LINE_LIMIT) }
    }
    handle.following = stream.source === 'file'
  }

  /** Stop a server and keep its row and its log. */
  async stop(entryId: string): Promise<void> {
    const handle = this.handles.get(entryId)
    if (handle) handle.stopping = true
    if (handle?.adopted) {
      // This server has no PTY of ours to destroy (it outlived the app that
      // launched it), so the process that holds the port is what stops it.
      await invoke('llamaCpp:stopServer', handle.entry.port)
    } else {
      await invoke('pty:destroy', llamaCppPtyId(entryId))
    }
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
      // An adopted server was already running when this page found it, so
      // leaving the page is not a reason to stop it.
      if (handle && !handle.adopted) {
        handle.stopping = true
        void invoke('pty:destroy', llamaCppPtyId(entryId))
      }
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
    const busy = this.portBusyNotice(handle.entry)
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
      [entryId]: busy || tail || `The server exited with code ${exitCode}`
    }
  }

  /** A failed bind is not a llama.cpp problem: the address is already taken by
   *  something that is not a llama-server, whose log line is cryptic next to a
   *  raw exit code. Another llama-server is handled before the start instead. */
  private portBusyNotice(entry: LlamaCppServerEntry): string {
    const lines = this.logs[entry.id] ?? []
    const busy = lines.some((line) => /couldn't bind HTTP server socket/iu.test(line))
    if (!busy) return ''
    return `Another program is using port ${entry.port}. Pick another port, or stop it first.`
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
      return
    }
    this.scheduleProbe(entry)
  }

  private stopHandle(entryId: string): void {
    const handle = this.handles.get(entryId)
    if (!handle) return
    // The file watcher lives in main, so it is closed explicitly instead of
    // waiting for the unsubscribe below to be noticed.
    if (handle.following) void invoke('llamaCpp:logStream', entryId, false)
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
