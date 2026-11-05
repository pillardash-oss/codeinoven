import { homedir } from 'os'
import type { AcpAgent, AcpAgentAuthStatus, AcpAuthMethod } from '../../lib/acp'
import { acpRecord, acpString } from '../drivers/acp/acp-protocol'
import { AcpClient } from '../drivers/acp/acp-client'
import { ACP_PROTOCOL_VERSION } from '../drivers/acp/acp-transport'
import { buildProcessEnvironmentAsync } from '../drivers/cli-environment'
import { findAcpAgent } from '../drivers/acp/acp-agents-store'
import { Logger } from '../system/logger'

/**
 * Sign-in state for the ACP agents the user added, asked of the agent itself.
 *
 * ACP agents own their providers, models and credentials: there is no
 * `auth status` subcommand to parse and no provider file to read, so the only
 * authority on whether the agent can work is the agent. The probe opens the
 * handshake, reads the auth methods it declares, and asks for a session: an
 * agent that needs a sign-in refuses that session and says so, which is both the
 * state and the sentence to show the user.
 */

const PROBE_TIMEOUT_MS = 30_000
/** A probe spawns a process, so a burst of status reads shares one answer. */
const CACHE_TTL_MS = 30_000
/**
 * A signed-in agent takes longer to go stale, and an agent that implements no
 * `session/close` keeps each probe session it opened, so a satisfied answer is
 * held longer than one that will send the user to a sign-in.
 */
const AUTHENTICATED_CACHE_TTL_MS = 5 * 60_000

interface CachedStatus {
  at: number
  status: AcpAgentAuthStatus
}

const cache = new Map<string, CachedStatus>()

/** Why an agent refused a session, when that refusal means "sign in first". */
const AUTH_REQUIRED_PATTERN =
  /auth|log ?in|sign ?in|credential|api key|token|unauthori[sz]ed|not signed/i

function fresh(cached: CachedStatus | undefined, now: number): boolean {
  if (!cached) return false
  const ttl = cached.status.state === 'authenticated' ? AUTHENTICATED_CACHE_TTL_MS : CACHE_TTL_MS
  return now - cached.at < ttl
}

function cacheKey(agent: AcpAgent): string {
  return `${agent.id}:${agent.updatedAt}`
}

/** One live handshake with the agent, torn down by the caller. */
interface AcpProbe {
  client: AcpClient
  methods: AcpAuthMethod[]
}

function readMethods(value: unknown): AcpAuthMethod[] {
  if (!Array.isArray(value)) return []
  const methods: AcpAuthMethod[] = []
  for (const entry of value) {
    const record = acpRecord(entry)
    const id = acpString(record?.['id'])
    if (!id) continue
    const where = acpString(record?.['description'])
    methods.push({
      id,
      name: acpString(record?.['name']) ?? id,
      ...(where ? { description: where } : {})
    })
  }
  return methods
}

async function spawnEnvironment(agent: AcpAgent): Promise<NodeJS.ProcessEnv> {
  const env = await buildProcessEnvironmentAsync()
  for (const [key, value] of Object.entries(agent.env)) env[key] = value
  return env
}

/**
 * Open the handshake and read the methods the agent declares.
 *
 * The client advertises no file or terminal capability: a probe must never be
 * able to edit a file or launch a terminal on the user's machine.
 */
async function openProbe(agent: AcpAgent, cwd: string): Promise<AcpProbe> {
  const client = new AcpClient({
    command: agent.command,
    args: agent.args,
    cwd,
    env: await spawnEnvironment(agent),
    onNotification: () => undefined,
    onRequest: async (method) => {
      throw new Error(`The ACP agent asked for "${method}" during an auth check.`)
    },
    onExit: () => undefined,
    requestTimeoutMs: PROBE_TIMEOUT_MS
  })
  client.start()
  const result = acpRecord(
    await client.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        auth: { terminal: false }
      },
      clientInfo: { name: 'CodeInOven', title: 'CodeInOven', version: '1.0.0' }
    })
  )
  return { client, methods: readMethods(result?.['authMethods']) }
}

/** Whether the agent will open a session, which is what "signed in" means here. */
async function sessionState(
  probe: AcpProbe,
  cwd: string
): Promise<{ state: AcpAgentAuthStatus['state']; detail?: string }> {
  try {
    const result = acpRecord(
      await probe.client.request('session/new', { cwd, mcpServers: [] }, PROBE_TIMEOUT_MS)
    )
    const sessionId = acpString(result?.['sessionId'])
    // A probe session is disposable: close it so repeated checks never leave
    // conversations behind in the agent's own history.
    if (sessionId) {
      await probe.client.request('session/close', { sessionId }, 10_000).catch(() => undefined)
    }
    return { state: 'authenticated' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      state: AUTH_REQUIRED_PATTERN.test(message) ? 'unauthenticated' : 'unknown',
      detail: message
    }
  }
}

/** Sign-in state of one configured ACP agent (cached briefly per agent revision). */
export async function acpAgentAuthStatus(
  agent: AcpAgent,
  projectPath?: string
): Promise<AcpAgentAuthStatus> {
  const key = cacheKey(agent)
  const cached = cache.get(key)
  if (fresh(cached, Date.now())) return (cached as CachedStatus).status

  const cwd = projectPath ?? homedir()
  let probe: AcpProbe | null = null
  let status: AcpAgentAuthStatus
  try {
    probe = await openProbe(agent, cwd)
    const session = await sessionState(probe, cwd)
    status = {
      state: session.state,
      methods: probe.methods,
      ...(session.detail ? { detail: session.detail } : {})
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    Logger.dev('ACP auth probe failed', message)
    status = { state: 'unknown', methods: [], detail: message }
  } finally {
    probe?.client.stop()
  }
  cache.set(key, { at: Date.now(), status })
  return status
}

/** Forget a cached answer, so a sign-in the user just ran is re-read. */
export function forgetAcpAgentAuth(agent: AcpAgent): void {
  cache.delete(cacheKey(agent))
}

/**
 * Ask the agent to run one of the sign-in methods it declared.
 *
 * ACP defines `authenticate { methodId }` as the client's request to the agent to
 * perform that method. An agent whose credentials already exist answers at once
 * (Cursor's `cursor_login`), and one that needs the browser or a terminal drives
 * it through its own flow.
 */
export async function authenticateAcpAgent(
  harnessId: string,
  methodId: string,
  projectPath?: string
): Promise<AcpAgentAuthStatus> {
  const agent = await findAcpAgent(harnessId)
  if (!agent) throw new Error('This ACP agent is no longer configured. Add it again in Harnesses.')
  const cwd = projectPath ?? homedir()
  const probe = await openProbe(agent, cwd)
  try {
    await probe.client.request('authenticate', { methodId }, PROBE_TIMEOUT_MS)
  } finally {
    probe.client.stop()
  }
  forgetAcpAgentAuth(agent)
  return acpAgentAuthStatus(agent, projectPath)
}
