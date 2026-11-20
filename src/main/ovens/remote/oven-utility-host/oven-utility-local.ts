/**
 * The Oven's own utility executor: what runs here instead of travelling to the app.
 *
 * A turn on an Oven carries two things with it: the routes its token may call and
 * the utilities it may run *here*. This module answers the routes the snapshot
 * alone can answer — search, docs, activation and invocation — and answers
 * `undefined` for everything else, which is how the host learns to forward app-
 * owned calls (`/manage`, `/diagnostics`, `/ask-secret`, `/suggest-utility`, the
 * app-control, orchestration, engineering, pawn and don tools) to the relay the
 * client opened.
 *
 * The three answers, in the order the host applies them:
 *
 * - a value: the call ran here, and this is its answer;
 * - `undefined`: not this Oven's to run, so the host forwards it;
 * - a thrown `OvenUtilityHttpError`: the call is this Oven's, and its input or its
 *   id was wrong. A local *failure* is never this: an MCP server that could not
 *   start forwards the same call to the app instead, because the app may well be
 *   able to run it.
 *
 * It is a thin composition root: the catalogue, the per-turn state, the four
 * routes and the wire shape each own one concern beside it.
 */
import { resolve } from 'node:path'
import type { OvenUtilityJson } from '../../../../lib/oven-utility-host'
import { Logger } from '../../../system/logger'
import type { OvenUtilityLocalHost, OvenUtilityLocalRunner } from './oven-utility-host-forward'
import { ovenUtilityGatewayResult } from './oven-utility-appliers'
import { activateOvenUtility, lookupOvenUtilityDocs } from './oven-utility-local-capability'
import { ovenUtilityCatalogue, type OvenUtilityLocalCall } from './oven-utility-local-context'
import { invokeOvenUtility } from './oven-utility-local-invoke'
import { resolveOvenUtilityTurnCredentials } from './oven-utility-local-credentials'
import type { OvenUtilityCredentialStore } from './oven-utility-secrets'
import { boundOvenUtilityOutput } from './oven-utility-local-output'
import { ovenUtilityProjectTerms, searchOvenUtilities } from './oven-utility-local-search'
import { OvenUtilityLocalTurns } from './oven-utility-local-turns'

/** Answers one granted route on this Oven, or `undefined` to forward it. */
type OvenUtilityLocalHandler = (
  call: OvenUtilityLocalCall,
  input: OvenUtilityJson
) => Promise<OvenUtilityJson | undefined>

export interface OvenUtilityLocalOptions {
  /**
   * The checkout this host sits in, used only when a turn names none.
   *
   * A turn normally carries the path of the checkout it works in, which is what
   * search ranks against. This is the fallback for a client that sent none: the
   * directory the Oven service was started in. A host started outside a checkout
   * simply has no project signals at all, and search still works.
   */
  contextPath?: string
  /**
   * This machine's at-rest credentials, when it keeps any.
   *
   * A turn's own env and headers always win; this only fills what the turn left
   * out, and it is read fresh for every call that can open a server, so a secret
   * forgotten between turns is never handed out again.
   */
  credentials?: OvenUtilityCredentialStore
}

/**
 * The routes that can open an MCP server, and so the only ones that need a
 * credential resolved. Search and the app-owned routes never touch the store.
 */
const CREDENTIAL_ROUTES = new Set(['activate', 'docs-lookup', 'invoke'])

/**
 * Build the Oven-local executor for one host.
 *
 * The returned host owns two lifetimes: per turn (activations and the MCP servers
 * they opened, all closed when the host retires that turn) and per host (every
 * turn's work, closed on `close()`). Nothing here reaches outside the machine.
 */
export function createOvenUtilityLocalHost(
  options: OvenUtilityLocalOptions = {}
): OvenUtilityLocalHost {
  const turns = new OvenUtilityLocalTurns()
  const contextPath = options.contextPath ?? process.cwd()
  /** One read per checkout, however many turns and calls work in it. */
  const termsByDirectory = new Map<string, Promise<ReadonlySet<string>>>()
  const termsFor = (directory: string): Promise<ReadonlySet<string>> => {
    let terms = termsByDirectory.get(directory)
    if (!terms) {
      terms = ovenUtilityProjectTerms(directory)
      termsByDirectory.set(directory, terms)
    }
    return terms
  }

  const run: OvenUtilityLocalRunner = async (turn, route, input) => {
    const handler = ovenUtilityLocalHandler(route)
    if (!handler) return undefined
    // The credentials this call's servers run with. Only a route that opens one
    // asks the store, and the answer is never kept for a later call.
    const credentials = options.credentials
    const resolved =
      credentials && CREDENTIAL_ROUTES.has(routeKey(route))
        ? await resolveOvenUtilityTurnCredentials(turn, credentials)
        : turn
    const call: OvenUtilityLocalCall = {
      turn: resolved,
      state: turns.of(resolved.turnId),
      catalogue: ovenUtilityCatalogue(resolved),
      // The turn's own checkout whenever it named one, so a search ranks what the
      // turn is working on and not whatever directory this daemon started in.
      projectTerms: () => termsFor(resolve(resolved.projectPath ?? contextPath))
    }
    const answer = await handler(call, input)
    // Every local answer leaves through the app's own shape, bounded the way the
    // app bounds one: `/invoke` returns an MCP payload and `/docs-lookup` returns
    // a whole manual, and neither may arrive at the model unbounded.
    return answer === undefined
      ? undefined
      : boundOvenUtilityOutput(ovenUtilityGatewayResult(answer))
  }

  return {
    run,
    retireTurn: async (turnId) => {
      // Retiring is how a turn stops existing, so it can never be the thing that
      // fails: a client that already gave up must not be told about a close.
      try {
        await turns.retire(turnId)
      } catch (error) {
        Logger.error('Could not close an Oven-local turn:', error)
      }
    },
    close: async () => {
      try {
        await turns.close()
      } catch (error) {
        Logger.error('Could not close the Oven-local utility work:', error)
      }
    }
  }
}

/**
 * The routes this Oven answers, by name.
 *
 * Route names compare without their slashes or case, the same way a grant does,
 * so `/invoke` and `invoke` reach the same handler. Everything not listed here is
 * app-owned and forwarded.
 */
function ovenUtilityLocalHandler(route: string): OvenUtilityLocalHandler | undefined {
  switch (routeKey(route)) {
    case 'search':
      return searchOvenUtilities
    case 'docs-lookup':
      return lookupOvenUtilityDocs
    case 'activate':
      return activateOvenUtility
    case 'invoke':
      return invokeOvenUtility
    default:
      return undefined
  }
}

/** One route name without its slashes or case, the way a grant compares. */
function routeKey(route: string): string {
  return route.replace(/^\/+/u, '').replace(/\/+$/u, '').toLocaleLowerCase('en-US')
}
