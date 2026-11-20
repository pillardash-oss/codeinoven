import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  OVEN_PROTOCOL_VERSION,
  type OvenProbe,
  type OvenRun,
  type OvenRunEvent,
  type StartOvenRunInput
} from '../../lib/ovens'
import type { OvenUtilitySecretVault } from '../../lib/oven-utility-host'
import {
  type OvenRootPeers,
  type OvenWorkspaceRequest,
  type OvenWorkspaceResult
} from '../../lib/ovens'
import { OVEN_UTILITY_HOST_MODE } from '../../lib/oven-utility-host'
import { mirrorLocalGitIdentity, OVEN_GIT_NETWORK_CHANNELS } from './oven-local-git-identity'
import { syncLocalGitHostTrust } from './oven-local-git-trust'
import {
  failedAnswerError,
  isStaleServiceFault,
  serviceBundleRevision
} from './oven-service-bundle'
import { Logger } from '../system/logger'
import { OvenServiceMissingError, OvenSsh } from './oven-ssh'
import type { OvenRegistry } from './oven-registry'
import { beginOvenHarnessRun } from './oven-operation-lock'
import { remoteShell } from './oven-remote-shell'
import {
  OvenChannelUnavailable,
  OvenRequestChannel,
  OvenServiceOutdated
} from './oven-request-channel'
import { remoteInstallServiceCommand, remoteServiceCommand } from './oven-remote-command'

/**
 * How long one file, Git, or repository action may run on the Oven.
 *
 * The work happens over the warm channel, so this is the point at which a
 * channel is judged wedged rather than a normal wait: a Git command on a large
 * checkout can legitimately take a minute, and it must not restart the session.
 */
const ROOT_OPERATION_TIMEOUT_MS = 120_000

/** The largest request one root operation may carry. */
const ROOT_OPERATION_LIMIT_BYTES = 8 * 1024 * 1024

/**
 * Where service maintenance reports the work it is doing for a caller's turn.
 *
 * A caller that has a turn on screen (an Oven turn starting its capability host)
 * passes one so the wait is named while it happens; every other caller omits it
 * and keeps its own reporting.
 */
export type OvenServiceNote = (note: string) => void

/**
 * True when an Oven has no service listening at all.
 *
 * The socket is a file on a POSIX Oven and a named pipe on Windows, and both
 * report `ENOENT` when nothing is bound. That is not a failed request: the
 * service simply is not running (a reboot on a POSIX Oven ends the daemon, and a
 * Windows machine can lose its scheduled task), and this app owns the file that
 * starts it.
 */
function serviceNotRunning(message: string): boolean {
  if (!/connect (?:ENOENT|ECONNREFUSED)/u.test(message)) return false
  return /service\.sock/u.test(message) || /codeinoven-oven-/u.test(message)
}

/**
 * Whether an answer proves the channel is older than the bundle on disk.
 *
 * A bundle from before file work moved into the channel forwards it to the daemon,
 * which knows nothing about it and used to blame a run id that was never sent. A
 * later bundle names the unknown method outright. Both mean the same thing: the
 * process answering is not the code this app installed.
 */
function staleChannelAnswer(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Invalid run ID|Unknown Oven request method/iu.test(message)
}

/** How one request should travel when the warm channel cannot carry it. */
interface SendOptions {
  /** How long the warm channel waits before it is judged wedged. */
  timeoutMs?: number
  /** The service mode the one-request fallback has to run. */
  mode?: 'request' | 'root-operation'
  /**
   * The payload the one-request fallback has to receive, when it differs.
   *
   * The warm channel reads envelopes (`method` plus `input`), while the one-shot
   * `root-operation` mode reads the input itself, so one body cannot be correct
   * for both. This is the body the fallback sends.
   */
  fallbackData?: string
}

/**
 * How long an Oven keeps the service it has before this app replaces it again.
 *
 * Replacing a service restarts it, so a bundle that cannot answer must not be
 * reinstalled on every request that fails. The floor makes a broken delivery
 * report itself instead of looping, and it still lets a later app update offer
 * the new bundle as soon as its revision differs.
 */
const SERVICE_REPAIR_COOLDOWN_MS = 60_000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A bundle from before the Oven's utility host answers that request this way.
 *
 * Its service knows the method list it shipped with, so anything newer is an
 * unknown method — the same shape `staleChannelAnswer` recognises for the
 * operations the warm channel carries.
 */
function unknownUtilityHostMethod(message: string): boolean {
  return /Unknown Oven request method/iu.test(message)
}

/**
 * The Oven's own refusal to be replaced while a run is still working.
 *
 * It arrives as the service's answer to the install, so this is the one failure
 * the app can clear itself instead of reporting.
 */
function activeRunsBlockUpdate(message: string): boolean {
  return /Finish active runs before updating the Oven service/iu.test(message)
}

/** How many runs a probe answer says the Oven is working on. */
function activeRunsIn(answer: string): number {
  try {
    const parsed = JSON.parse(answer.replace(/^\uFEFF/u, '')) as {
      value?: { activeRuns?: unknown }
    }
    return typeof parsed.value?.activeRuns === 'number' ? parsed.value.activeRuns : 0
  } catch {
    return 0
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** One attempt, kept as an outcome so a failure can be classified before it is thrown. */
type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown }

async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, error }
  }
}

export class OvenService {
  readonly ssh: OvenSsh
  private readonly channel: OvenRequestChannel
  /** This app's own service bundle, read and hashed once. */
  private bundle: Promise<{ source: string; revision: string }> | undefined
  /** Per-Oven guard, so a service that keeps failing cannot be reinstalled in a loop. */
  private readonly serviceRepairs = new Map<string, number>()
  private readonly repairingServices = new Map<string, Promise<boolean>>()
  /** Why the last automatic service update on an Oven did not happen. */
  private readonly serviceFaults = new Map<string, string>()
  /**
   * The runs this process started on each Oven.
   *
   * A service cannot be replaced under a run that is still working, and this set
   * is what tells the difference between a run this app is driving and one it
   * inherited from a service it can no longer talk to.
   */
  private readonly startedRuns = new Map<string, Set<string>>()

  constructor(readonly registry: OvenRegistry) {
    this.ssh = new OvenSsh(registry)
    this.channel = new OvenRequestChannel(this.ssh, async () => (await this.ownBundle()).revision)
  }

  /**
   * Start the Oven's request channel before anything needs it.
   *
   * Called wherever the user points the app at an Oven, so the first file tree or
   * prompt does not pay for the remote process startup the channel exists to
   * avoid. Resolves either way: a warm-up that fails is retried by the request
   * that needs it.
   *
   * An Oven still running an older service is updated here, at the moment the
   * user reaches for it, instead of waiting for the first action to fail.
   */
  async warm(id: string): Promise<void> {
    try {
      await this.channel.warm(id)
    } catch (error) {
      if (error instanceof OvenServiceOutdated) await this.refreshService(id, error.message)
    }
  }

  /** Whether this Oven's channel is already open. */
  isWarm(id: string): boolean {
    return this.channel.isWarm(id)
  }

  /** Close one Oven's channel, e.g. after it was removed or its service replaced. */
  disposeChannel(id: string): void {
    this.channel.dispose(id)
  }

  /** Close every channel, as the app does on quit. */
  disposeChannels(): void {
    this.channel.disposeAll()
  }

  /**
   * Install this app's service bundle on the Oven and start it.
   *
   * The bundle is replaced, so this is also how an Oven that still runs an
   * older service catches up with the app (see `probe` and `request`). The
   * answer is verified against the pushed revision: an Oven that kept its own
   * service must say so, instead of reporting whatever that service said.
   */
  async install(id: string): Promise<OvenProbe> {
    const { source, revision } = await this.ownBundle()
    const shell = await remoteShell(this.ssh, id)
    const command = remoteInstallServiceCommand(shell, revision, randomUUID())
    let output: string
    try {
      output = await this.ssh.execute(id, command, source, 60_000)
    } catch (error) {
      // The Oven refuses to be replaced under a run that is still working. A run
      // this process did not start belongs to a service it can no longer talk to,
      // and it would otherwise hold the Oven on that service forever: every later
      // send would fail the same way while nothing was actually being done.
      if (!activeRunsBlockUpdate(messageOf(error)) || !(await this.stopAbandonedRuns(id)))
        throw error
      output = await this.ssh.execute(id, command, source, 60_000)
    }
    // The channel runs the bundle that was installed when it started, so it is
    // replaced rather than left answering from the old service.
    this.channel.dispose(id)
    // An explicit install re-arms the automatic refresh for this Oven.
    this.serviceRepairs.delete(id)
    const probe = this.parseProbe(output)
    if (probe.serviceRevision !== revision)
      throw new Error(
        'The Oven kept the service it was running instead of the one just installed. Finish any active runs on it, then install the service again.'
      )
    this.serviceFaults.delete(id)
    return probe
  }

  /**
   * Read an oven's live state.
   *
   * `refresh` asks the oven-side service to re-scan harness versions instead of
   * answering from its own short-lived cache. Only harness management wants
   * that, so ordinary connection probes stay cheap.
   *
   * A probe is also the moment this app can see which service the Oven runs, so
   * an Oven left on an older bundle is brought up to date here rather than
   * failing every later request with that bundle's own error. A working answer
   * is still returned when the refresh cannot run (active runs, no disk space),
   * because the Oven does work; the refresh is retried on a later probe.
   */
  async probe(id: string, refresh = false): Promise<OvenProbe> {
    const input = refresh ? { method: 'probe', refresh: true } : { method: 'probe' }
    const probe = this.parseProbe(await this.request(id, input))
    if (probe.serviceRevision === (await this.ownBundle()).revision) return probe
    if (!(await this.refreshService(id, 'The Oven runs a different service revision.')))
      return probe
    return this.parseProbe(await this.request(id, input))
  }

  async runs(id: string): Promise<OvenRun[]> {
    return this.decode<OvenRun[]>(await this.control(id, { method: 'runs' }))
  }

  async start(id: string, input: StartOvenRunInput): Promise<OvenRun> {
    const release = beginOvenHarnessRun(id, input.command)
    try {
      const run = this.decode<OvenRun>(await this.request(id, { method: 'start', input }))
      const started = this.startedRuns.get(id) ?? new Set<string>()
      started.add(input.id)
      this.startedRuns.set(id, started)
      return run
    } finally {
      release()
    }
  }

  /**
   * Where this Oven's own utility host listens.
   *
   * A turn that runs on an Oven runs on that machine, so this app's loopback
   * gateway is not reachable from it and the Oven hosts its own. This is how the
   * app learns the port that host answers on before it opens a relay to it.
   *
   * A bundle from before the host existed answers this request as an unknown
   * method rather than with one of the stale answers `withServiceRepair` already
   * recognises. The Oven's service file is this app's own artifact, so that
   * answer is treated the same way: the service is replaced once, under the same
   * cooldown, and the same call is sent again.
   */
  async utilityHost(id: string, note?: OvenServiceNote): Promise<{ port: number }> {
    const input = { method: OVEN_UTILITY_HOST_MODE }
    const first = await attempt(() => this.request(id, input, note))
    if (first.ok) return this.utilityHostPort(first.value)
    if (!unknownUtilityHostMethod(messageOf(first.error))) throw first.error
    if (!(await this.refreshService(id, messageOf(first.error), note)))
      throw this.serviceUpdateFailure(
        id,
        'This Oven runs an older service. Install the service again from its settings.',
        first.error
      )
    // The replacement restarted the daemon, and its host is started on the next
    // request. Say so, because that request is the wait the reader is in.
    note?.("Starting the Oven's capability host…")
    return this.utilityHostPort(await this.request(id, input, note))
  }

  /** The port an Oven's utility host answered with, once it is known to be usable. */
  private utilityHostPort(answer: string): { port: number } {
    const host = this.decode<{ port: number }>(answer)
    if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535)
      throw new Error('The Oven utility host answered an invalid port.')
    return { port: host.port }
  }

  /**
   * What this Oven can keep at rest, and which utilities it already holds.
   *
   * The host listens on that machine's loopback, which this app cannot reach, so
   * the question goes through the Oven's daemon. An unavailable vault is an
   * answer, not a failure: that machine simply runs on the per-turn push.
   */
  async utilitySecrets(id: string): Promise<OvenUtilitySecretVault> {
    const vault = this.decode<OvenUtilitySecretVault>(
      await this.request(id, { method: 'utility-secrets' })
    )
    if (!Array.isArray(vault.stored))
      throw new Error('The Oven answered an invalid credential store.')
    return vault
  }

  /**
   * Allow, or stop allowing, this Oven to keep utility credentials at rest.
   *
   * Turning it on writes nothing by itself: a credential arrives with the turn
   * that uses it, and is kept from then on. Turning it off forgets everything
   * that Oven held.
   */
  async setUtilitySecretStore(id: string, enabled: boolean): Promise<{ enabled: boolean }> {
    const answer = this.decode<{ enabled: boolean }>(
      await this.request(id, { method: 'utility-secrets-enabled', input: { enabled } })
    )
    return { enabled: answer.enabled === true }
  }

  /** Forget one utility's stored credentials on this Oven, or every one of them. */
  async forgetUtilitySecrets(id: string, utilityId?: string): Promise<{ forgotten: number }> {
    const forgotten = this.decode<{ forgotten: number }>(
      await this.request(id, {
        method: 'utility-secret-forget',
        input: utilityId === undefined ? {} : { utilityId }
      })
    )
    return { forgotten: Number.isInteger(forgotten.forgotten) ? forgotten.forgotten : 0 }
  }

  async events(
    id: string,
    runId: string,
    after: number
  ): Promise<{ run: OvenRun; events: OvenRunEvent[] }> {
    return this.decode(await this.control(id, { method: 'events', runId, after }))
  }

  async write(id: string, runId: string, input: string, closeInput = false): Promise<void> {
    this.decode(await this.control(id, { method: 'write', runId, input, closeInput }))
  }

  async stop(id: string, runId: string): Promise<void> {
    this.decode(await this.control(id, { method: 'stop', runId }))
    this.startedRuns.get(id)?.delete(runId)
  }

  /**
   * Stop the runs holding an Oven on a service this app is replacing.
   *
   * Returns false when there is nothing to clear, so the caller reports the
   * refusal it already has instead of an update that was never attempted.
   */
  private async stopAbandonedRuns(id: string): Promise<boolean> {
    const runs = await attempt(() => this.runs(id))
    if (!runs.ok || !Array.isArray(runs.value)) return false
    const started = this.startedRuns.get(id) ?? new Set<string>()
    for (const run of runs.value) if (run.status !== 'running') started.delete(run.id)
    const abandoned = runs.value.filter((run) => run.status === 'running' && !started.has(run.id))
    if (abandoned.length === 0) return false
    Logger.info('Stopping runs that block the Oven service update', {
      ovenId: id,
      runIds: abandoned.map((run) => run.id)
    })
    for (const run of abandoned) await attempt(() => this.stop(id, run.id))
    // A stopped run is given a moment to exit before the update is attempted
    // again, because the Oven counts it until its own process is gone.
    for (let poll = 0; poll < 20; poll++) {
      const answer = await attempt(() => this.control(id, { method: 'probe' }))
      if (!answer.ok) break
      if (activeRunsIn(answer.value) === 0) return true
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return true
  }

  /**
   * Forget a finished run's journal and record.
   *
   * The Oven keeps runs in memory under a fixed cap and refuses to remove one
   * whose process is still alive, so a caller that starts a run of its own
   * (an account-quota probe) removes it once it is done rather than spending
   * one of that cap on work nobody will read again.
   */
  async remove(id: string, runId: string): Promise<void> {
    this.decode(await this.control(id, { method: 'remove', runId }))
  }

  /**
   * Filesystem and Git work inside one checkout on the Oven.
   *
   * A clone first mirrors the identity this machine already authenticates with
   * and shares the host keys this machine already trusts, so the Oven clones as
   * the user without a manual key setup.
   */
  async workspace(
    id: string,
    input: OvenWorkspaceRequest,
    localRepository?: string
  ): Promise<OvenWorkspaceResult> {
    if (input.operation === 'clone') {
      await syncLocalGitHostTrust(this.ssh, id)
      const mirror = await mirrorLocalGitIdentity(this.ssh, id, localRepository)
      const output = await this.ssh.execute(
        id,
        remoteServiceCommand(await remoteShell(this.ssh, id), ['workspace']),
        `${JSON.stringify({ ...input, ...(mirror ? { localIdentityFile: mirror.file } : {}) })}\n`,
        150_000,
        undefined,
        true
      )
      return this.decode<OvenWorkspaceResult>(output)
    }
    return this.decode(await this.request(id, { method: 'workspace', input }))
  }

  /**
   * One desktop handler executing against an Oven checkout.
   *
   * Network Git channels mirror the local identity and its host trust first;
   * every other channel runs with the checkout as it stands.
   *
   * A file, Git, or repository action is ordinary work, so it travels over the
   * warm channel: one round trip to a process that is already reading requests.
   * It used to run as its own `ssh` invocation that started a second Node and
   * loaded the whole service before the action began, and it queued behind every
   * other action on that machine. That is why opening a folder, listing a
   * directory and reading the first file each took a visible pause.
   *
   * Network Git stays on its own invocation because it needs agent forwarding,
   * which the shared session does not open, and the user already expects to wait
   * for a push or a pull.
   */
  async rootOperation(
    id: string,
    root: string,
    projectId: string,
    channel: string,
    args: unknown[],
    localRepository?: string,
    peers?: OvenRootPeers
  ): Promise<unknown> {
    const network = OVEN_GIT_NETWORK_CHANNELS.has(channel)
    let localIdentityFile: string | undefined
    if (network) {
      await syncLocalGitHostTrust(this.ssh, id)
      localIdentityFile = (await mirrorLocalGitIdentity(this.ssh, id, localRepository))?.file
    }
    const input = {
      root,
      projectId,
      channel,
      ...(localIdentityFile ? { localIdentityFile } : {}),
      ...(peers ? { peers } : {}),
      arguments: args.map((value) => ({
        present: value !== undefined,
        ...(value !== undefined ? { value } : {})
      }))
    }
    // The session validates the protocol version before it answers file work, and
    // an action that arrives without one is refused as a mismatch. Every payload
    // this app sends therefore names the version it speaks, on both routes.
    const data = JSON.stringify({ ...input, protocolVersion: OVEN_PROTOCOL_VERSION })
    if (Buffer.byteLength(data) > ROOT_OPERATION_LIMIT_BYTES)
      throw new Error('The Oven operation exceeds 8 MiB.')
    if (!network) {
      // The warm channel reads envelopes, never bare inputs. A line without a
      // `method` is neither file work nor a run request, so the channel handed it
      // to the daemon, which answered "Invalid run ID." and then named the missing
      // method: every file action on a channel took that detour.
      const envelope = JSON.stringify({
        method: 'root-operation',
        protocolVersion: OVEN_PROTOCOL_VERSION,
        input
      })
      const output = await this.withServiceRepair(id, () =>
        this.send(id, envelope, {
          timeoutMs: ROOT_OPERATION_TIMEOUT_MS,
          mode: 'root-operation',
          fallbackData: data
        })
      )
      try {
        return this.decode<unknown>(output)
      } catch (error) {
        // A channel whose process predates this bundle still forwards the request
        // to a daemon that may not know it. Replacing the channel is the repair,
        // and the work then runs against the bundle on disk.
        if (!staleChannelAnswer(error)) throw error
        this.channel.dispose(id)
        return this.decode<unknown>(await this.oneShot(id, data, 'root-operation'))
      }
    }
    // The command is built once, before any repair runs: a second attempt must
    // repeat the same call, never re-resolve the shell in the middle of it.
    const command = remoteServiceCommand(await remoteShell(this.ssh, id), ['root-operation'])
    const output = await this.withServiceRepair(id, () =>
      this.ssh.execute(
        id,
        command,
        `${data}\n`,
        150_000,
        undefined,
        true,
        ROOT_OPERATION_LIMIT_BYTES
      )
    )
    return this.decode<unknown>(output)
  }

  async putFile(id: string, root: string, path: string, data: Buffer, mode = 0o600): Promise<void> {
    const staged = `${path}.${randomUUID()}.next`
    for (let offset = 0; offset < data.length || offset === 0; offset += 128 * 1024) {
      await this.workspace(id, {
        operation: 'write',
        root,
        path: staged,
        offset,
        data: data.subarray(offset, offset + 128 * 1024).toString('base64'),
        exclusive: offset === 0,
        mode
      })
    }
    await this.workspace(id, { operation: 'replace', root, path, staged, mode })
  }

  private async request(
    id: string,
    input: Record<string, unknown>,
    note?: OvenServiceNote
  ): Promise<string> {
    const data = JSON.stringify({ ...input, protocolVersion: OVEN_PROTOCOL_VERSION })
    if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('The Oven request exceeds 1 MiB.')
    return await this.withServiceRepair(id, () => this.send(id, data), note)
  }

  /**
   * Run control: the run inventory, its events, its steering input, its stop.
   *
   * Every bundle this app speaks to answers these, and stopping the run is the
   * only way to release the Oven for the service replacement it is waiting for.
   * Repairing the service first is what made Stop impossible exactly when it was
   * needed: an Oven refuses to replace its service while a run is active, so a
   * guard that requires the current service here can never be satisfied. These
   * requests therefore go to whatever service the Oven is already running, and
   * the update happens on the next ordinary request once the run is gone.
   */
  private async control(id: string, input: Record<string, unknown>): Promise<string> {
    const data = JSON.stringify({ ...input, protocolVersion: OVEN_PROTOCOL_VERSION })
    if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('The Oven request exceeds 1 MiB.')
    try {
      return await this.channel.request(id, data, undefined, { acceptOutdated: true })
    } catch (error) {
      // A channel that will not open is not a refused request. Stopping a run is
      // worth one process, which is also the path an Oven without a warm session
      // would take anyway.
      if (error instanceof OvenChannelUnavailable || error instanceof OvenServiceMissingError)
        return await this.oneShot(id, data)
      throw error
    }
  }

  /**
   * Run one Oven call, replacing the service first if it answers as an older one.
   *
   * File and Git actions used to bypass this, so an Oven still running an older
   * bundle answered its file work with its own protocol error ("Oven protocol
   * version mismatch") and the app reported that instead of updating the service
   * it owns. Every call now goes through the same repair: a stale answer is
   * replaced once, then the same call runs again.
   */
  private async withServiceRepair(
    id: string,
    run: () => Promise<string>,
    note?: OvenServiceNote
  ): Promise<string> {
    const first = await attempt(run)
    const fault = this.serviceFaultOf(first)
    if (!fault) {
      if (!first.ok) throw first.error
      return first.value
    }
    // A stopped daemon can answer through the SSH process as { ok: false } too.
    // Recover before decode() throws that payload outside this repair boundary.
    if (!(await this.refreshService(id, fault.message, note)))
      throw this.serviceUpdateFailure(
        id,
        serviceNotRunning(fault.message)
          ? 'The Oven service is not running and automatic recovery could not start it. Check its service settings.'
          : 'This Oven runs an older service than this app. Install the service again from its settings.',
        fault
      )
    const second = await attempt(run)
    if (!second.ok) throw second.error
    return second.value
  }

  /** A stopped or outdated service, from either a thrown error or a JSON answer. */
  private serviceFaultOf(result: Attempt<string>): Error | null {
    const message = result.ok ? failedAnswerError(result.value) : messageOf(result.error)
    if (!message || (!isStaleServiceFault(message) && !serviceNotRunning(message))) return null
    return result.ok ? new Error(message) : toError(result.error)
  }

  /**
   * The error a caller raises when the service could not be updated.
   *
   * The reason the update itself gave is carried through. It used to be dropped
   * for "finish its active runs", which sent the reader to stop runs that were
   * not running while the real cause (a full disk, a service that would not
   * start, a refused install) went unsaid.
   */
  private serviceUpdateFailure(id: string, fallback: string, cause: unknown): Error {
    const fault = this.serviceFaults.get(id)
    return new Error(fault ? `${fallback} The update failed: ${fault}` : fallback, { cause })
  }

  /**
   * Replace one Oven's service, at most once per cooldown.
   *
   * Returns false when it must not run now, so the caller reports what it
   * already has instead of an install failure the user did not ask for.
   */
  private async refreshService(
    id: string,
    reason: string,
    note?: OvenServiceNote
  ): Promise<boolean> {
    const pending = this.repairingServices.get(id)
    if (pending) return pending
    const last = this.serviceRepairs.get(id) ?? 0
    if (Date.now() - last < SERVICE_REPAIR_COOLDOWN_MS) return false
    this.serviceRepairs.set(id, Date.now())
    const repair = (async () => {
      // The install is a whole bundle push and a daemon restart, so it is named
      // before it starts rather than after: this is exactly the wait a send
      // that showed nothing used to hide.
      note?.('Reinstalling the Oven service…')
      Logger.info('Installing the current Oven service', { ovenId: id, reason })
      const startedAt = Date.now()
      try {
        await this.install(id)
        // A successful install used to log nothing, so a log that ended here
        // read exactly like a hang. One line closes that gap.
        this.serviceFaults.delete(id)
        Logger.info('Installed the current Oven service', {
          ovenId: id,
          durationMs: Date.now() - startedAt
        })
        return true
      } catch (error) {
        this.serviceFaults.set(id, messageOf(error))
        Logger.error('The Oven service could not be installed', {
          ovenId: id,
          error: messageOf(error)
        })
        return false
      } finally {
        // install() re-arms manual recovery. Automatic repair retains its floor.
        this.serviceRepairs.set(id, Date.now())
        this.repairingServices.delete(id)
      }
    })()
    this.repairingServices.set(id, repair)
    return repair
  }

  /** This app's own bundle, read and hashed exactly once per process. */
  private ownBundle(): Promise<{ source: string; revision: string }> {
    this.bundle ??= (async () => {
      // Inside the packaged app this path is read through the asar archive.
      const source = await readFile(join(app.getAppPath(), 'out/main/oven-service.mjs'), 'utf8')
      // Hashed exactly as the standalone agent and the published CLI hash it, so
      // one build yields one revision on every delivery path.
      return { source, revision: serviceBundleRevision(source) }
    })()
    return this.bundle
  }

  /**
   * One request through the channel, falling back to a process per request.
   *
   * A channel that cannot start is not a failed request, and a missing service
   * file is this app's own artifact to restore, so both are repaired here. An
   * Oven answering from an older bundle is replaced once before its work is
   * retried: the channel carries operations that bundle does not know.
   */
  private async send(id: string, data: string, options: SendOptions = {}): Promise<string> {
    const mode = options.mode ?? 'request'
    const fallback = options.fallbackData ?? data
    try {
      return await this.channel.request(id, data, options.timeoutMs)
    } catch (error) {
      if (error instanceof OvenServiceOutdated) {
        if (!(await this.refreshService(id, error.message)))
          throw this.serviceUpdateFailure(
            id,
            'This Oven runs an older service. Install the service again from its settings.',
            error
          )
        return await this.channel.request(id, data, options.timeoutMs)
      }
      if (error instanceof OvenChannelUnavailable) {
        // Nothing is listening on the Oven: start the service it already has
        // instead of reporting a failure the user would read as "install it
        // again" for a machine that only needs its daemon back.
        if (
          serviceNotRunning(error.message) &&
          (await this.refreshService(id, 'The Oven service is not running.'))
        )
          return await this.channel.request(id, data, options.timeoutMs)
        return await this.oneShot(id, fallback, mode)
      }
      // A channel opened before the installed bundle was replaced keeps running
      // the code it started with, so file work that bundle cannot answer comes
      // back naming a run that was never sent. The channel is stale, not the
      // request: close it and run the operation against the bundle on disk.
      if (mode === 'root-operation' && staleChannelAnswer(error)) {
        this.channel.dispose(id)
        return await this.oneShot(id, fallback, mode)
      }
      if (!(error instanceof OvenServiceMissingError)) throw error
      await this.install(id)
      return await this.oneShot(id, fallback, mode)
    }
  }

  /** One request in its own ssh process, the path a cold or broken channel uses. */
  private async oneShot(
    id: string,
    data: string,
    mode: 'request' | 'root-operation' = 'request'
  ): Promise<string> {
    const shell = await remoteShell(this.ssh, id)
    const command = remoteServiceCommand(shell, [mode])
    try {
      return await this.ssh.execute(id, command, `${data}\n`)
    } catch (error) {
      // The service file is the app's own artifact on the Oven. When it is gone
      // (a reimaged machine or a wiped home), place it again and run the request
      // once more instead of failing the Oven for a file only this app manages.
      if (!(error instanceof OvenServiceMissingError)) throw error
      await this.install(id)
      return await this.ssh.execute(id, command, `${data}\n`)
    }
  }

  private decode<T>(output: string): T {
    // PowerShell can prefix a UTF-8 BOM; `JSON.parse` rejects it.
    const response = JSON.parse(output.replace(/^\uFEFF/u, '')) as {
      ok: boolean
      value?: T
      error?: string
    }
    if (response.ok !== true) throw new Error(response.error || 'The Oven request failed.')
    return response.value as T
  }

  private parseProbe(output: string): OvenProbe {
    const value = this.decode<OvenProbe>(output)
    if (value.protocolVersion !== OVEN_PROTOCOL_VERSION || !Array.isArray(value.harnesses)) {
      throw new Error(
        'The Oven service uses a different protocol. Install the current service to reconnect.'
      )
    }
    return value
  }
}
