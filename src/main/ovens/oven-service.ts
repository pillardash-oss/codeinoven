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
import { serviceBundleRevision } from './oven-service-bundle'
import { syncLocalGitHostTrust } from './oven-local-git-trust'
import { OVEN_HARNESS_PATH } from './oven-harness-paths'
import { OVEN_DATA_DIRECTORY } from './remote/oven-root-paths'
import { OvenSsh, sshQuote } from './oven-ssh'
import type { OvenRegistry } from './oven-registry'
import { beginOvenHarnessRun } from './oven-operation-lock'

const REMOTE_ROOT = `"$HOME/${OVEN_DATA_DIRECTORY}"`
const SERVICE = `${REMOTE_ROOT}/service.mjs`
// The login shell supplies version-manager PATH. Only a verified Node runtime is used.
const NODE_CHECK =
  `${OVEN_HARNESS_PATH} ` +
  'set -eu; command -v node >/dev/null 2>&1 || { printf "Node.js is required on this Oven\\n" >&2; exit 1; }; node -e \'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)\''

export class OvenService {
  readonly ssh: OvenSsh
  constructor(readonly registry: OvenRegistry) {
    this.ssh = new OvenSsh(registry)
  }

  /** Installing touches only the authenticated user's CodeInOven service directory. */
  async install(id: string): Promise<OvenProbe> {
    const path = join(app.getAppPath(), 'out/main/oven-service.mjs')
    // Hashed exactly as the standalone agent and the published CLI hash it, so
    // one build yields one revision on every delivery path.
    const source = await readFile(path, 'utf8')
    const revision = serviceBundleRevision(source)
    const staged = `${REMOTE_ROOT}/service.${randomUUID()}.next`
    const command = `${NODE_CHECK}; umask 077; mkdir -p ${REMOTE_ROOT}; trap 'rm -f ${staged}' EXIT; cat > ${staged}; test "$(sha256sum < ${staged} | cut -d ' ' -f 1)" = ${sshQuote(revision)}; mv ${staged} ${SERVICE}; CODEINOVEN_OVEN_REVISION=${sshQuote(revision)} node ${SERVICE} ensure`
    const output = await this.ssh.execute(id, command, source, 60_000)
    return this.parseProbe(output)
  }

  /**
   * Read an oven's live state.
   *
   * `refresh` asks the oven-side service to re-scan harness versions instead of
   * answering from its own short-lived cache. Only harness management wants
   * that, so ordinary connection probes stay cheap.
   */
  async probe(id: string, refresh = false): Promise<OvenProbe> {
    return this.parseProbe(
      await this.request(id, refresh ? { method: 'probe', refresh: true } : { method: 'probe' })
    )
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
        `${NODE_CHECK}; node ${SERVICE} workspace`,
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
    if (Buffer.byteLength(data) > 8 * 1024 * 1024)
      throw new Error('The Oven operation exceeds 8 MiB.')
    const output = await this.ssh.execute(
      id,
      `${NODE_CHECK}; node ${SERVICE} root-operation`,
      `${data}\n`,
      150_000,
      undefined,
      network,
      8 * 1024 * 1024
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

  private request(id: string, input: Record<string, unknown>): Promise<string> {
    const data = JSON.stringify({ ...input, protocolVersion: OVEN_PROTOCOL_VERSION })
    if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('The Oven request exceeds 1 MiB.')
    return this.ssh.execute(id, `${NODE_CHECK}; node ${SERVICE} request`, `${data}\n`)
  }

  private decode<T>(output: string): T {
    const response = JSON.parse(output) as { ok: boolean; value?: T; error?: string }
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
