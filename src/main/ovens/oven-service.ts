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
import {
  type OvenRootPeers,
  type OvenWorkspaceRequest,
  type OvenWorkspaceResult
} from '../../lib/ovens'
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

/** How one request should travel when the warm channel cannot carry it. */
interface SendOptions {
  /** How long the warm channel waits before it is judged wedged. */
  timeoutMs?: number
  /** The service mode the one-request fallback has to run. */
  mode?: 'request' | 'root-operation'
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
    const output = await this.ssh.execute(id, command, source, 60_000)
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
    return this.decode<OvenRun[]>(await this.request(id, { method: 'runs' }))
  }

  async start(id: string, input: StartOvenRunInput): Promise<OvenRun> {
    const release = beginOvenHarnessRun(id, input.command)
    try {
      return this.decode<OvenRun>(await this.request(id, { method: 'start', input }))
    } finally {
      release()
    }
  }

  async events(
    id: string,
    runId: string,
    after: number
  ): Promise<{ run: OvenRun; events: OvenRunEvent[] }> {
    return this.decode(await this.request(id, { method: 'events', runId, after }))
  }

  async write(id: string, runId: string, input: string, closeInput = false): Promise<void> {
    this.decode(await this.request(id, { method: 'write', runId, input, closeInput }))
  }

  async stop(id: string, runId: string): Promise<void> {
    this.decode(await this.request(id, { method: 'stop', runId }))
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
    const data = JSON.stringify(input)
    if (Buffer.byteLength(data) > ROOT_OPERATION_LIMIT_BYTES)
      throw new Error('The Oven operation exceeds 8 MiB.')
    if (!network)
      return this.decode<unknown>(
        await this.send(id, data, {
          timeoutMs: ROOT_OPERATION_TIMEOUT_MS,
          mode: 'root-operation'
        })
      )
    const output = await this.ssh.execute(
      id,
      remoteServiceCommand(await remoteShell(this.ssh, id), ['root-operation']),
      `${data}\n`,
      150_000,
      undefined,
      true,
      ROOT_OPERATION_LIMIT_BYTES
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

  private async request(id: string, input: Record<string, unknown>): Promise<string> {
    const data = JSON.stringify({ ...input, protocolVersion: OVEN_PROTOCOL_VERSION })
    if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('The Oven request exceeds 1 MiB.')
    const first = await attempt(() => this.send(id, data))
    const fault = this.serviceFaultOf(first)
    if (!fault) {
      if (!first.ok) throw first.error
      return first.value
    }
    // The answer came from a service this app did not install, and this app owns
    // that file on the Oven. Replace it once, then send the same request again.
    if (!(await this.refreshService(id, fault.message))) throw fault
    const second = await attempt(() => this.send(id, data))
    if (!second.ok) throw second.error
    return second.value
  }

  /** The failure that proves a request met an outdated service, if any. */
  private serviceFaultOf(result: Attempt<string>): Error | null {
    if (!result.ok)
      return isStaleServiceFault(messageOf(result.error)) ? toError(result.error) : null
    const answer = failedAnswerError(result.value)
    return answer && isStaleServiceFault(answer) ? new Error(answer) : null
  }

  /**
   * Replace one Oven's service, at most once per cooldown.
   *
   * Returns false when it must not run now, so the caller reports what it
   * already has instead of an install failure the user did not ask for.
   */
  private async refreshService(id: string, reason: string): Promise<boolean> {
    const last = this.serviceRepairs.get(id) ?? 0
    if (Date.now() - last < SERVICE_REPAIR_COOLDOWN_MS) return false
    this.serviceRepairs.set(id, Date.now())
    Logger.info('Installing the current Oven service', { ovenId: id, reason })
    try {
      await this.install(id)
      return true
    } catch (error) {
      Logger.error('The Oven service could not be installed', {
        ovenId: id,
        error: messageOf(error)
      })
      return false
    }
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
    try {
      return await this.channel.request(id, data, options.timeoutMs)
    } catch (error) {
      if (error instanceof OvenServiceOutdated) {
        if (!(await this.refreshService(id, error.message)))
          throw new Error(
            'This Oven runs an older service. Finish its active runs, then install the service again from its settings.',
            { cause: error }
          )
        return await this.channel.request(id, data, options.timeoutMs)
      }
      if (error instanceof OvenChannelUnavailable) return await this.oneShot(id, data, mode)
      if (!(error instanceof OvenServiceMissingError)) throw error
      await this.install(id)
      return await this.oneShot(id, data, mode)
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
