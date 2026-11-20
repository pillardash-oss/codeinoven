/**
 * The turns an Oven's utility host remembers.
 *
 * A turn is a capability, not a session: it is a token, the routes that token
 * may call, and the utilities it may run here. The host holds no conversation
 * state, so this registry is the whole of it, and every way a turn can end
 * (its client retires it, its relay disconnects, its client dies and it goes
 * idle) has to remove it from here. Nothing else may hold a turn.
 */
import {
  type OvenUtilityMcpServer,
  type OvenUtilityTurn,
  type OvenUtilityTurnInput,
  type OvenUtilityTurnUtility
} from '../../../../lib/oven-utility-host'
import { OvenUtilityHttpError } from '../oven-utility-http'

/**
 * How long a turn may sit unused before the host forgets it.
 *
 * A client that dies takes its relay with it and its turn with that, so this is
 * the last resort for the paths nobody reports: an Oven left running with a
 * stale registry would otherwise answer a token that should have expired an
 * hour ago. A turn in active use refreshes its own timestamp on every call, and
 * a call can legitimately hold for the whole relay timeout (a human fetching a
 * secret), so the TTL is far longer than that.
 */
export const OVEN_UTILITY_TURN_IDLE_TTL_MS = 60 * 60 * 1000

/** One turn as the host holds it: the contract's turn plus its last use. */
export interface RegisteredOvenUtilityTurn extends OvenUtilityTurn {
  /** When the host last answered, or last looked up, this turn. */
  lastUsedAt: number
}

export class OvenUtilityTurns {
  private readonly turns = new Map<string, RegisteredOvenUtilityTurn>()
  private readonly byTokenIndex = new Map<string, string>()

  get size(): number {
    return this.turns.size
  }

  /** Every registered turn, for callers that report on the host. */
  list(): readonly RegisteredOvenUtilityTurn[] {
    return [...this.turns.values()]
  }

  /**
   * Register one turn, retiring whatever it replaces.
   *
   * A retried `start` (a reconnecting relay, a client that repeats itself) must
   * leave exactly one turn behind, and two turns must never share a token, so
   * both collisions are resolved by retiring the older entry.
   */
  register(value: unknown, now: number = Date.now()): RegisteredOvenUtilityTurn {
    const input = parseOvenUtilityTurnInput(value)
    this.pruneStale(now)
    this.retire(input.turnId)
    const previous = this.byTokenIndex.get(input.token)
    if (previous !== undefined) this.retire(previous)
    const turn: RegisteredOvenUtilityTurn = {
      ...input,
      createdAt: now,
      lastUsedAt: now
    }
    this.turns.set(turn.turnId, turn)
    this.byTokenIndex.set(turn.token, turn.turnId)
    return turn
  }

  /**
   * The turn one bearer token names, or null.
   *
   * A turn found past its idle TTL is retired as it is looked up, so a stale
   * token can never be answered even once.
   */
  byToken(token: string, now: number = Date.now()): RegisteredOvenUtilityTurn | null {
    const turnId = this.byTokenIndex.get(token)
    if (turnId === undefined) return null
    const turn = this.turns.get(turnId)
    if (!turn) {
      this.byTokenIndex.delete(token)
      return null
    }
    if (now - turn.lastUsedAt > OVEN_UTILITY_TURN_IDLE_TTL_MS) {
      this.retire(turnId)
      return null
    }
    turn.lastUsedAt = now
    return turn
  }

  byId(turnId: string): RegisteredOvenUtilityTurn | null {
    return this.turns.get(turnId) ?? null
  }

  /** Forget one turn. Answers whether it existed. */
  retire(turnId: string): boolean {
    const turn = this.turns.get(turnId)
    if (!turn) return false
    this.turns.delete(turnId)
    if (this.byTokenIndex.get(turn.token) === turnId) this.byTokenIndex.delete(turn.token)
    return true
  }

  /** Forget every turn; the host is going away. */
  retireAll(): void {
    this.turns.clear()
    this.byTokenIndex.clear()
  }

  /** Retire every turn idle past the TTL. Answers how many went. */
  pruneStale(now: number = Date.now()): number {
    let retired = 0
    for (const turn of [...this.turns.values()]) {
      if (now - turn.lastUsedAt <= OVEN_UTILITY_TURN_IDLE_TTL_MS) continue
      if (this.retire(turn.turnId)) retired += 1
    }
    return retired
  }
}

/** Longest id or token a client may present; longer ones are a mistake, not a turn. */
const MAX_IDENTIFIER_LENGTH = 512
const MAX_TURN_UTILITIES = 256
const MAX_TURN_GRANTS = 256

/**
 * Validate one turn a client asked the host to remember.
 *
 * Everything here arrived over an unauthenticated-looking POST that only the
 * machine's own credential can make, but it is still JSON from another process:
 * a malformed turn must be refused with a readable reason instead of becoming a
 * half-registered capability that fails later, mid-call.
 */
export function parseOvenUtilityTurnInput(value: unknown): OvenUtilityTurnInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OvenUtilityHttpError(400, 'A turn must be an object.')
  const record = value as Record<string, unknown>
  const turnId = identifier(record['turnId'], 'turnId')
  const token = identifier(record['token'], 'token')
  const grants = stringList(record['grants'], 'grants', MAX_TURN_GRANTS)
  const utilitiesValue = record['utilities']
  if (!Array.isArray(utilitiesValue) || utilitiesValue.length > MAX_TURN_UTILITIES)
    throw new OvenUtilityHttpError(400, 'A turn needs a bounded list of utilities.')
  const utilities = utilitiesValue.map((entry) => turnUtility(entry))
  const client = text(record['client'], 'client', 200)
  const relayUrl = record['relayUrl'] === undefined ? undefined : relayUrlValue(record['relayUrl'])
  return {
    turnId,
    token,
    grants,
    utilities,
    client,
    ...(relayUrl ? { relayUrl } : {})
  }
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.includes('\0')
  )
    throw new OvenUtilityHttpError(400, `A turn needs a valid ${field}.`)
  return value
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    throw new OvenUtilityHttpError(400, `A turn needs a valid ${field}.`)
  return value
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    throw new OvenUtilityHttpError(400, `A turn needs a valid ${field}.`)
  return value
}

function stringList(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new OvenUtilityHttpError(400, `A turn needs a bounded list of ${field}.`)
  return value.map((entry) => text(entry, field, MAX_IDENTIFIER_LENGTH))
}

/**
 * The relay a turn carries calls back through, which must be this Oven's own
 * loopback: the host forwards plain HTTP, and nothing about a turn may make it
 * reach anywhere else.
 */
function relayUrlValue(value: unknown): string {
  const url = text(value, 'relayUrl', 2_048)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new OvenUtilityHttpError(400, 'A turn needs a valid relayUrl.')
  }
  const loopback =
    parsed.protocol === 'http:' &&
    (parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '[::1]')
  if (!loopback)
    throw new OvenUtilityHttpError(400, 'A turn relay must be a loopback http URL on this Oven.')
  return url
}

function turnUtility(value: unknown): OvenUtilityTurnUtility {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OvenUtilityHttpError(400, 'Each utility in a turn must be an object.')
  const record = value as Record<string, unknown>
  const id = identifier(record['id'], 'utility id')
  const kind = text(record['kind'], 'utility kind', 200)
  const name = text(record['name'], 'utility name', 400)
  const description = text(record['description'], 'utility description', 8_192)
  const docs = optionalText(record['docs'], 'utility docs', 256 * 1024)
  const server = record['server'] === undefined ? undefined : mcpServer(record['server'])
  return {
    id,
    kind,
    name,
    description,
    ...(docs === undefined ? {} : { docs }),
    ...(server === undefined ? {} : { server })
  }
}

function mcpServer(value: unknown): OvenUtilityMcpServer {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OvenUtilityHttpError(400, 'An MCP server in a turn must be an object.')
  const record = value as Record<string, unknown>
  const transport = record['transport']
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse')
    throw new OvenUtilityHttpError(400, 'An MCP server in a turn needs a known transport.')
  const environment = record['env']
  const env: Record<string, string> = {}
  if (environment !== undefined) {
    if (!environment || typeof environment !== 'object' || Array.isArray(environment))
      throw new OvenUtilityHttpError(400, 'An MCP server in a turn needs a plain env object.')
    for (const [key, entry] of Object.entries(environment as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
        throw new OvenUtilityHttpError(400, 'An MCP server in a turn has an invalid env name.')
      env[key] = text(entry, 'MCP server env value', 32_768)
    }
  }
  const command = optionalText(record['command'], 'MCP server command', 4_096)
  const url = optionalText(record['url'], 'MCP server url', 4_096)
  const cwd = optionalText(record['cwd'], 'MCP server cwd', 4_096)
  const args = record['args'] === undefined ? undefined : stringList(record['args'], 'args', 512)
  return {
    utilityId: identifier(record['utilityId'], 'MCP server utilityId'),
    name: text(record['name'], 'MCP server name', 400),
    transport,
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(url === undefined ? {} : { url }),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(cwd === undefined ? {} : { cwd })
  }
}
