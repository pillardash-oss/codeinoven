/**
 * The credential store's three administrative requests, as the daemon answers them.
 *
 * The app can reach this daemon and cannot reach the host's loopback, so the
 * three calls an app makes about an Oven's at-rest credentials are forwarded
 * here: the daemon ensures the host is running, reads its 0600 state file for the
 * machine credential, and asks the host the question over the Oven's own
 * loopback. The answer is the host's decoded envelope value.
 *
 * Precedence is unchanged by travelling: the turn's own credentials still win,
 * and this path only toggles the opt-in, writes one bundle, or forgets it. A
 * value travels in one direction only and is never logged or echoed back.
 */
import { request as httpRequest } from 'node:http'
import type { OvenUtilityJson } from '../../../lib/oven-utility-host'
import {
  ovenUtilityEnvelope,
  ovenUtilityUrl,
  postOvenUtilityJson,
  type OvenUtilityPostResult
} from './oven-utility-http'
import { readOvenUtilityHostState } from './oven-utility-host/oven-utility-host-state'

/** The three requests the daemon adds for the app, spelled exactly once. */
export type OvenUtilityAdminRequest =
  'utility-secrets' | 'utility-secrets-enabled' | 'utility-secret-forget'

/** What one administrative request needs from the daemon. */
export interface OvenUtilityAdminContext {
  /** The Oven account's home, where the host publishes its state file. */
  home: string
  /** Start the host, or find the one already running, and report its port. */
  ensureHost(): Promise<{ port: number }>
}

/** How long one administrative call to the host may take. */
const ADMIN_TIMEOUT_MS = 15_000

/** One utility id as the app and the host spell it. */
const UTILITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u

/**
 * Answer one credential-store request by asking this Oven's utility host.
 *
 * The host is ensured first, because a machine that has never run a turn still
 * has an answer about whether it can keep a credential, and the app must be able
 * to read that answer without starting a turn.
 */
export async function answerOvenUtilityAdminRequest(
  request: OvenUtilityAdminRequest,
  input: unknown,
  context: OvenUtilityAdminContext
): Promise<OvenUtilityJson> {
  const body = adminBody(request, input)
  await context.ensureHost()
  const state = await readOvenUtilityHostState(context.home)
  if (!state) throw new Error('The Oven utility host is not reachable.')
  const url = `${ovenUtilityUrl(state.port)}${adminRoute(request)}`
  if (request === 'utility-secrets') return await getOvenUtilityJson(url, state.hostToken)
  const result = await postOvenUtilityJson(url, body, {
    token: state.hostToken,
    timeoutMs: ADMIN_TIMEOUT_MS
  })
  return requiredValue(result, adminRoute(request))
}

/** The host route one administrative request calls. */
function adminRoute(request: OvenUtilityAdminRequest): string {
  switch (request) {
    case 'utility-secrets':
      return '/host/secrets'
    case 'utility-secrets-enabled':
      return '/host/secrets/enabled'
    case 'utility-secret-forget':
      return '/host/secret/forget'
  }
}

/**
 * The body one administrative request carries, validated here so the host only
 * ever sees a real boolean or a well-formed id.
 */
function adminBody(request: OvenUtilityAdminRequest, input: unknown): OvenUtilityJson {
  const record = adminRecord(input)
  switch (request) {
    case 'utility-secrets':
      return null
    case 'utility-secrets-enabled': {
      const enabled = record['enabled']
      if (typeof enabled !== 'boolean')
        throw new Error('The Oven secret store needs enabled to be true or false.')
      return { enabled }
    }
    case 'utility-secret-forget': {
      const utilityId = record['utilityId']
      if (utilityId === undefined || utilityId === null) return {}
      if (typeof utilityId !== 'string' || !UTILITY_ID.test(utilityId))
        throw new Error('Forgetting an Oven credential needs a valid utilityId.')
      return { utilityId }
    }
  }
}

/** The request input as an object, since a socket hands over parsed JSON. */
function adminRecord(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input))
    throw new Error('The Oven credential request needs an object input.')
  return input as Record<string, unknown>
}

/** The value of a host answer, or the host's own error when it refused. */
function requiredValue(result: OvenUtilityPostResult, route: string): OvenUtilityJson {
  if (result.envelope?.ok === true) return result.envelope.value
  if (result.envelope?.ok === false) throw new Error(result.envelope.error)
  throw new Error(
    `The Oven utility host answered ${route} with something the daemon cannot read (HTTP ${result.status}).`
  )
}

/** GET one host route with the machine credential and read its envelope. */
export async function getOvenUtilityJson(
  url: string,
  token: string,
  timeoutMs: number = ADMIN_TIMEOUT_MS
): Promise<OvenUtilityJson> {
  const target = new URL(url)
  return await new Promise<OvenUtilityJson>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port.length > 0 ? Number(target.port) : 80,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        timeout: timeoutMs
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').trim()
          let envelope: ReturnType<typeof ovenUtilityEnvelope>
          try {
            envelope = text ? ovenUtilityEnvelope(JSON.parse(text) as unknown) : null
          } catch {
            envelope = null
          }
          if (envelope?.ok === true) resolve(envelope.value)
          else if (envelope?.ok === false) reject(new Error(envelope.error))
          else
            reject(
              new Error(
                `The Oven utility host answered ${target.pathname} with something the daemon cannot read (HTTP ${response.statusCode ?? 0}).`
              )
            )
        })
      }
    )
    request.on('timeout', () =>
      request.destroy(new Error(`No answer from ${target.origin} in time.`))
    )
    request.on('error', reject)
    request.end()
  })
}
