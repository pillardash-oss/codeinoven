import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  OVEN_PROTOCOL_VERSION,
  type OvenProbe,
  type OvenRun,
  type OvenRunEvent,
  type StartOvenRunInput
} from '../../lib/ovens'
import { OvenSsh, sshQuote } from './oven-ssh'
import type { OvenRegistry } from './oven-registry'

const REMOTE_ROOT = '"$HOME/.config/pillardash/codeinoven-oven"'
const SERVICE = `${REMOTE_ROOT}/service.mjs`
// The login shell supplies version-manager PATH. Only a verified Node runtime is used.
const NODE_CHECK =
  'set -eu; command -v node >/dev/null 2>&1 || { printf "Node.js is required on this Oven\\n" >&2; exit 1; }; node -e \'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)\''

export class OvenService {
  readonly ssh: OvenSsh
  constructor(readonly registry: OvenRegistry) {
    this.ssh = new OvenSsh(registry)
  }

  /** Installing touches only the authenticated user's CodeInOven service directory. */
  async install(id: string): Promise<OvenProbe> {
    const path = join(app.getAppPath(), 'out/main/oven-service.mjs')
    const source = await readFile(path, 'utf8')
    const revision = createHash('sha256').update(source).digest('hex')
    const staged = `${REMOTE_ROOT}/service.${randomUUID()}.next`
    const command = `${NODE_CHECK}; umask 077; mkdir -p ${REMOTE_ROOT}; trap 'rm -f ${staged}' EXIT; cat > ${staged}; test "$(sha256sum < ${staged} | cut -d ' ' -f 1)" = ${sshQuote(revision)}; mv ${staged} ${SERVICE}; CODEINOVEN_OVEN_REVISION=${sshQuote(revision)} node ${SERVICE} ensure`
    const output = await this.ssh.execute(id, command, source, 60_000)
    return this.parseProbe(output)
  }

  async probe(id: string): Promise<OvenProbe> {
    return this.parseProbe(await this.request(id, { method: 'probe' }))
  }

  async runs(id: string): Promise<OvenRun[]> {
    return this.decode<OvenRun[]>(await this.request(id, { method: 'runs' }))
  }

  async start(id: string, input: StartOvenRunInput): Promise<OvenRun> {
    return this.decode<OvenRun>(await this.request(id, { method: 'start', input }))
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
