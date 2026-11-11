/**
 * Live state for the Local AI page's servers: which rows the app started, what
 * their logs say, and whether the server actually answers.
 *
 * A row is only "running" once its `/v1/models` endpoint answers, because a
 * process that is alive but still loading a 2 GB model cannot serve a turn yet.
 * The processes themselves live in the main process's PTY service; this class
 * subscribes to their streams and never spawns anything itself.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import {
  localAiModelAliases,
  localAiModelSource,
  localAiPtyId,
  localAiServerArgs,
  type LlamaCppBrewJobKind,
  type LlamaCppLogStream,
  type LlamaCppProbeResult,
  type LlamaCppServerEntry,
  type LocalAiModelLocation
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
    await invoke('localAi:stopServer', pending.entry.port, pending.entry.runtime)
    await this.spawn(pending.entry, pending.executable)
  }

  cancelTakeover(): void {
    this.pendingTakeover = null
  }

  /** Whether a row's own model is among the ids a server answers with. */
  private servesEntry(entry: LlamaCppServerEntry, models: readonly string[]): boolean {
    const aliases = localAiModelAliases(entry)
    return models.some((served) => aliases.includes(served))
  }

  /**
   * Called once a row's download has finished and the model's folder is known, so
   * the saved row can name that folder instead of the tag it came from.
   */
  onModelLocalized: ((entry: LlamaCppServerEntry, location: LocalAiModelLocation) => void) | null =
    null

  /** Folders already resolved, so a readiness poll never repeats the lookup. */
  private locations = new SvelteMap<string, LocalAiModelLocation>()
  /** Folders already handed to the page, so the record is written once. */
  private handedOff = new SvelteSet<string>()

  /**
   * Where the weights this row asks for are on disk right now, or null while they
   * are still being fetched.
   *
   * A row that already names a folder is on disk by definition, so only a tag is
   * ever asked about. The answer is the same call that decides the row is ready:
   * a server whose generator is alive but whose weights are still arriving cannot
   * serve a turn, so "downloaded" is the honest line for both.
   */
  private async modelLocationOf(entry: LlamaCppServerEntry): Promise<LocalAiModelLocation | null> {
    if (localAiModelSource(entry)?.kind !== 'huggingface') return null
    const key = `${entry.id}\u0000${entry.modelReference}`
    const known = this.locations.get(key)
    if (known) return known
    try {
      const location = await invoke(
        'localAi:modelLocation',
        entry.modelReference,
        entry.host,
        entry.port,
        entry.runtime
      )
      if (!location) return null
      this.locations.set(key, location)
      return location
    } catch {
      return null
    }
  }

  /**
   * Hand a finished download's folder to the page once, which owns the saved
   * config. The row is written while it runs, so the next app start loads the
   * folder instead of asking the hub about a repository it already has.
   */
  private localizeModel(entry: LlamaCppServerEntry, location: LocalAiModelLocation | null): void {
    if (!location) return
    const key = `${entry.id}\u0000${entry.modelReference}`
    if (this.handedOff.has(key)) return
    this.handedOff.add(key)
    this.onModelLocalized?.(entry, location)
  }

  private async probeOf(entry: LlamaCppServerEntry): Promise<LlamaCppProbeResult> {
    try {
      return await invoke('localAi:probe', entry.host, entry.port, entry.runtime)
    } catch {
      return { ready: false, models: [], error: 'The readiness probe failed' }
    }
  }

  /** Launch the row in a terminal, streaming its output into the card. */
  private async spawn(entry: LlamaCppServerEntry, executable: string): Promise<void> {
    // Only llama.cpp can be told to keep a log file; MLX prints to its terminal,
    // so its card is empty until the server is started from this page again.
    const args = localAiServerArgs(
      entry,
      entry.runtime === 'llama.cpp' ? await this.logPathOf(entry.id) : undefined
    )
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

    const ptyId = localAiPtyId(entry.id)
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
    await this.seedLog(entry)
  }

  /** Take over a server that is already answering this row's model. */
  private async adopt(entry: LlamaCppServerEntry, modelId: string): Promise<void> {
    if (this.handles.has(entry.id)) return
    const ptyId = localAiPtyId(entry.id)
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
    void this.modelLocationOf(entry).then((location) => this.localizeModel(entry, location))
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
      ready = (await invoke('localAi:probe', entry.host, entry.port, entry.runtime)).ready
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
      return await invoke('localAi:logPath', entryId)
    } catch {
      return undefined
    }
  }

  /** Show what a row's log file already holds, without following it. */
  private async seedLog(entry: LlamaCppServerEntry): Promise<void> {
    // An MLX server writes no log file, so there is nothing to seed and the card
    // keeps its empty state until the row is started here again.
    if (entry.runtime !== 'llama.cpp') return
    if ((this.logs[entry.id] ?? []).length > 0) return
    try {
      const lines = await invoke('localAi:logTail', entry.id)
      if (lines.length === 0 || this.handles.has(entry.id)) return
      this.logs = { ...this.logs, [entry.id]: lines.slice(-LOG_LINE_LIMIT) }
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
    if (!handle || entry.runtime !== 'llama.cpp') return
    let stream: LlamaCppLogStream
    try {
      stream = await invoke('localAi:logStream', entry.id, true)
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
      await invoke('localAi:stopServer', handle.entry.port, handle.entry.runtime)
    } else {
      await invoke('pty:destroy', localAiPtyId(entryId))
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
        void invoke('pty:destroy', localAiPtyId(entryId))
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
    // llama.cpp says `couldn't bind HTTP server socket`, and the MLX server
    // surfaces the operating system's own `[Errno 48]` for the same thing.
    const busy = lines.some((line) =>
      /couldn't bind HTTP server socket|address already in use|errno 48/iu.test(line)
    )
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
      void invoke('pty:destroy', localAiPtyId(entry.id))
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
      result = await invoke('localAi:probe', entry.host, entry.port, entry.runtime)
    } catch {
      result = { ready: false, models: [], error: 'The readiness probe failed' }
    }
    // An MLX server answers its health endpoint from the moment its generator
    // loop is up, which is before a single weight has been read. Its weights on
    // disk are the honest ready line, and they are what the row is rewritten to.
    const location = result.ready ? await this.modelLocationOf(entry) : null
    if (!this.handles.has(entry.id)) return
    if (result.ready && (entry.runtime !== 'mlx' || !this.isReferenceRow(entry) || location)) {
      handle.timer = null
      this.setStatus(entry.id, 'running')
      this.setLoadedModel(entry.id, result.models[0] ?? '')
      this.notice = { ...this.notice, [entry.id]: '' }
      this.localizeModel(entry, location)
      return
    }
    this.scheduleProbe(entry)
  }

  /** Whether this row asks for a model that has to be fetched before it runs. */
  private isReferenceRow(entry: LlamaCppServerEntry): boolean {
    return localAiModelSource(entry)?.kind === 'huggingface'
  }

  private stopHandle(entryId: string): void {
    const handle = this.handles.get(entryId)
    if (!handle) return
    // The file watcher lives in main, so it is closed explicitly instead of
    // waiting for the unsubscribe below to be noticed.
    if (handle.following) void invoke('localAi:logStream', entryId, false)
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
