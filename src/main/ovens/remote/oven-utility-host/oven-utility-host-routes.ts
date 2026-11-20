/**
 * The routes one Oven's utility host answers.
 *
 * Two kinds of caller share one listener. The machine's own credential (`the
 * host token`, read out of the 0600 state file) mints and retires turns, and
 * administers the at-rest credential store. A turn token minted that way may then
 * call exactly the routes its grants name, and nothing else: the gateway a
 * harness was pointed at is this listener, so a route it calls arrives here as a
 * path, with the call input as the body.
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  OVEN_UTILITY_HOST_PROTOCOL,
  type OvenUtilityJson,
  type OvenUtilityStoredSecret
} from '../../../../lib/oven-utility-host'
import { Logger } from '../../../system/logger'
import {
  OvenUtilityHttpError,
  ovenUtilityPath,
  readOvenUtilityJson,
  sendOvenUtilityEnvelope
} from '../oven-utility-http'
import { ovenUtilityJson } from './oven-utility-appliers'
import { answerOvenUtilityCall, type OvenUtilityLocalRunner } from './oven-utility-host-forward'
import { OvenUtilityTurns } from './oven-utility-host-turns'
import type { OvenUtilitySecrets } from './oven-utility-secrets'

const HOST_STATUS = '/host/status'
const HOST_TURN = '/host/turn'
const HOST_TURN_RETIRE = '/host/turn/retire'
const HOST_TURN_RELAY_GONE = '/host/turn/relay-gone'
const HOST_SECRETS = '/host/secrets'
const HOST_SECRETS_ENABLED = '/host/secrets/enabled'
const HOST_SECRET = '/host/secret'
const HOST_SECRET_FORGET = '/host/secret/forget'
const BEARER_PREFIX = 'Bearer '

/** What one host's listener needs to answer: its identity, its turns, its seams. */
export interface OvenUtilityHostRouteContext {
  /** The port the listener is bound to, which the host publishes in its state file. */
  port: () => number
  /** Revision of the service bundle that started this host. */
  revision: string
  hostToken: string
  turns: OvenUtilityTurns
  /** Answers a call on the Oven; `undefined` forwards it to the turn's relay. */
  localRunner?: OvenUtilityLocalRunner
  /** This machine's at-rest credentials, opt-in and off by default. */
  secrets: OvenUtilitySecrets
}

/** The `createServer` listener for one host. */
export function createOvenUtilityHostListener(
  context: OvenUtilityHostRouteContext
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void answer(context, request, response)
  }
}

async function answer(
  context: OvenUtilityHostRouteContext,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    const path = ovenUtilityPath(request.url)
    const value = path.startsWith('/host/')
      ? await answerHostRoute(context, request, path)
      : await answerTurnRoute(context, request, path)
    sendOvenUtilityEnvelope(response, 200, { ok: true, value })
  } catch (error) {
    const status = error instanceof OvenUtilityHttpError ? error.status : 500
    // A route that reports "not granted" or "needs its app" is answering, not
    // failing, so only an answer nobody planned for is worth an error line.
    if (!(error instanceof OvenUtilityHttpError))
      Logger.error('Oven utility host call failed:', error)
    sendOvenUtilityEnvelope(response, status, {
      ok: false,
      error: error instanceof Error ? error.message : 'The Oven utility host failed.'
    })
  }
}

/** The routes only the machine credential may call: turn lifecycle and status. */
async function answerHostRoute(
  context: OvenUtilityHostRouteContext,
  request: IncomingMessage,
  path: string
): Promise<OvenUtilityJson> {
  requireHostCredential(context, request)
  if (path === HOST_STATUS) {
    requireMethod(request, 'GET', path)
    return {
      protocolVersion: OVEN_UTILITY_HOST_PROTOCOL,
      port: context.port(),
      revision: context.revision,
      turns: context.turns.size
    }
  }
  if (path === HOST_TURN) {
    if (request.method === 'POST') {
      const turn = context.turns.register(await readOvenUtilityJson(request))
      return { turnId: turn.turnId }
    }
    requireMethod(request, 'DELETE', path)
    return retireTurn(context, await readOvenUtilityJson(request))
  }
  if (path === HOST_TURN_RETIRE || path === HOST_TURN_RELAY_GONE) {
    requireMethod(request, 'POST', path)
    return retireTurn(context, await readOvenUtilityJson(request))
  }
  if (path === HOST_SECRETS) {
    requireMethod(request, 'GET', path)
    return ovenUtilityJson(await context.secrets.status())
  }
  if (path === HOST_SECRETS_ENABLED) {
    requireMethod(request, 'POST', path)
    const enabled = (await requireBodyRecord(request, path))['enabled']
    if (typeof enabled !== 'boolean')
      throw new OvenUtilityHttpError(400, 'The secret store needs enabled to be true or false.')
    return await context.secrets.setEnabled(enabled)
  }
  if (path === HOST_SECRET) {
    requireMethod(request, 'POST', path)
    return await context.secrets.remember(
      await storedSecret(await requireBodyRecord(request, path))
    )
  }
  if (path === HOST_SECRET_FORGET) {
    requireMethod(request, 'POST', path)
    const body = await requireBodyRecord(request, path)
    return { forgotten: await context.secrets.forget(optionalUtilityId(body)) }
  }
  throw new OvenUtilityHttpError(404, `Unknown utility host route: ${path}.`)
}

/**
 * The JSON object one administrative call carries.
 *
 * A credential write has no optional body: the caller must say what to keep, so
 * an empty body is a caller mistake rather than an empty bundle.
 */
async function requireBodyRecord(
  request: IncomingMessage,
  path: string
): Promise<Record<string, OvenUtilityJson>> {
  const body = await readOvenUtilityJson(request)
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new OvenUtilityHttpError(400, `${path} needs a JSON object.`)
  return body
}

/** One stored credential bundle, validated before it reaches any backend. */
function storedSecret(body: Record<string, OvenUtilityJson>): OvenUtilityStoredSecret {
  const utilityId = body['utilityId']
  if (!isUtilityId(utilityId))
    throw new OvenUtilityHttpError(400, 'A stored credential needs a valid utilityId.')
  const env = credentialMap(body['env'], 'env', true)
  if (!env) throw new OvenUtilityHttpError(400, 'A stored credential needs an env object.')
  const headers = credentialMap(body['headers'], 'headers', false)
  return { utilityId, env, ...(headers ? { headers } : {}) }
}

/** One map of credential names to string values, bounded like a request body. */
function credentialMap(
  value: OvenUtilityJson | undefined,
  field: string,
  required: boolean
): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    if (required)
      throw new OvenUtilityHttpError(400, `A stored credential needs an ${field} object.`)
    return undefined
  }
  if (typeof value !== 'object' || Array.isArray(value))
    throw new OvenUtilityHttpError(400, `A stored credential's ${field} must be an object.`)
  const entries = Object.entries(value)
  if (entries.length > 64)
    throw new OvenUtilityHttpError(
      400,
      `A stored credential's ${field} carries at most 64 entries.`
    )
  const map: Record<string, string> = {}
  for (const [key, entry] of entries) {
    if (typeof entry !== 'string' || key.includes('\0'))
      throw new OvenUtilityHttpError(400, `A stored credential's ${field} must map names to text.`)
    map[key] = entry
  }
  return map
}

/** The utility one forget call names, or every one when it names none. */
function optionalUtilityId(body: Record<string, OvenUtilityJson>): string | undefined {
  const utilityId = body['utilityId']
  if (utilityId === undefined || utilityId === null) return undefined
  if (!isUtilityId(utilityId))
    throw new OvenUtilityHttpError(400, 'Forgetting a credential needs a valid utilityId.')
  return utilityId
}

/** One utility id as the app and this host spell it. */
function isUtilityId(value: OvenUtilityJson | undefined): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('\0')
  )
}

/**
 * Turn a turn's `{turnId}` body into a retirement.
 *
 * Retiring an unknown turn is not an error: a relay that reconnects, or a
 * client whose turn already expired, is doing the right thing and only needs to
 * know whether anything was still there.
 */
function retireTurn(
  context: OvenUtilityHostRouteContext,
  body: OvenUtilityJson | undefined
): OvenUtilityJson {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new OvenUtilityHttpError(400, 'Retiring a turn needs its turnId.')
  const turnId = (body as Record<string, OvenUtilityJson>)['turnId']
  if (typeof turnId !== 'string' || turnId.length === 0)
    throw new OvenUtilityHttpError(400, 'Retiring a turn needs its turnId.')
  return { turnId, retired: context.turns.retire(turnId) }
}

/** The one route family a turn token can reach, gated by that turn's grants. */
async function answerTurnRoute(
  context: OvenUtilityHostRouteContext,
  request: IncomingMessage,
  route: string
): Promise<OvenUtilityJson> {
  if (request.method !== 'POST')
    throw new OvenUtilityHttpError(405, `A utility route answers POST only: ${route}.`)
  const turn = context.turns.byToken(bearer(request))
  if (!turn)
    throw new OvenUtilityHttpError(401, 'This turn is not registered on the Oven utility host.')
  const granted = turn.grants.some((grant) => routeKey(grant) === routeKey(route))
  if (!granted) throw new OvenUtilityHttpError(403, 'Tool is not granted to this turn')
  const input = (await readOvenUtilityJson(request)) ?? null
  return await answerOvenUtilityCall(turn, route, input, context.localRunner)
}

/** The machine credential, compared without leaking a prefix through timing. */
function requireHostCredential(
  context: OvenUtilityHostRouteContext,
  request: IncomingMessage
): void {
  if (!sameSecret(bearer(request), context.hostToken))
    throw new OvenUtilityHttpError(401, 'The utility host credential is not valid.')
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX))
    throw new OvenUtilityHttpError(401, 'A turn or host credential is required.')
  const token = header.slice(BEARER_PREFIX.length).trim()
  if (token.length === 0)
    throw new OvenUtilityHttpError(401, 'A turn or host credential is required.')
  return token
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function requireMethod(request: IncomingMessage, method: string, path: string): void {
  if (request.method !== method)
    throw new OvenUtilityHttpError(405, `${path} answers ${method} only.`)
}

/**
 * Route names compare without their slashes or case.
 *
 * Grants travel from the client's own catalog, and the same tool is spelled
 * `/invoke` there and `invoke` in a few older places, so the comparison is on
 * the tool's name rather than on one punctuation convention.
 */
function routeKey(value: string): string {
  return value.replace(/^\/+/u, '').replace(/\/+$/u, '').toLocaleLowerCase('en-US')
}
