/**
 * `cio_util_find` on the Oven: search the turn's own snapshot.
 *
 * The app's search ranks a live registry and adds project signals from the
 * checkout the turn runs in. The Oven has neither: it has the list of utilities
 * its client sent with the turn, and nothing else. So the scoring is the app's
 * idea kept small (an exact phrase in the name beats one in the description beats
 * one in the identity, and each word scores again on its own), plus one cheap
 * tie-breaker read from the turn's own checkout — the `projectPath` the client
 * named, or this daemon's directory when it named none — which is never allowed
 * to fail the search.
 *
 * The answer keeps the app's shape, because it is read by the same agent: a
 * lexical mismatch returns project-aware candidates rather than "not found", and
 * only an empty catalogue proves a capability is absent. When nothing in the
 * snapshot matches at all, the call is forwarded to the app instead, which owns
 * the live registry and may well hold what this snapshot never carried.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OvenUtilityJson, OvenUtilityTurnUtility } from '../../../../lib/oven-utility-host'
import {
  inputRecord,
  optionalKinds,
  optionalNumber,
  optionalText,
  type OvenUtilityLocalCall
} from './oven-utility-local-context'

const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'capability',
  'for',
  'i',
  'need',
  'of',
  'or',
  'the',
  'to',
  'tool',
  'use',
  'using',
  'utility',
  'with'
])

/**
 * What each kind is also called in a request.
 *
 * A user asks for "the web", "a browser", "somewhere to run SQL", never for
 * `web_search` or `mcp`, so without this an intent query only ever matches a name
 * someone happened to write in the same words.
 */
const KIND_ALIASES: Readonly<Record<string, string>> = {
  mcp: 'mcp integration connector server external tools',
  skill: 'skill instructions workflow knowledge procedure playbook',
  web_search: 'web internet online search research lookup',
  web_fetch: 'web internet url page website fetch read download',
  computer_use:
    'computer desktop screen mouse keyboard click type scroll gui ui application automation',
  provider: 'provider model api inference llm',
  image_descriptor:
    'image descriptor describe vision picture photo screenshot see visual caption alt text'
}

/** Most matches one search may return, matching the app's own ceiling. */
const SEARCH_LIMIT_MAXIMUM = 20
const SEARCH_LIMIT_DEFAULT = 8

/** The project context a search reads once per checkout, for the whole turn. */
export async function ovenUtilityProjectTerms(directory: string): Promise<ReadonlySet<string>> {
  const terms = new Set<string>()
  await addPackageTerms(terms, directory)
  await addReadmeTerms(terms, directory)
  return terms
}

/**
 * The names a checkout declares, which is the strongest signal of what it is.
 *
 * A directory that cannot be read simply has no project signals, so a turn whose
 * `projectPath` is absent, unreadable or gone never fails its search over it.
 */
async function addPackageTerms(terms: Set<string>, directory: string): Promise<void> {
  let raw: string
  try {
    raw = await readFile(join(directory, 'package.json'), 'utf8')
  } catch {
    return
  }
  if (raw.length > 1_000_000) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  if (!isPlainRecord(parsed)) return
  addTerms(terms, parsed['name'])
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies'
  ]) {
    const dependencies = parsed[field]
    if (!isPlainRecord(dependencies)) continue
    for (const packageName of Object.keys(dependencies)) addTerms(terms, packageName)
  }
}

/** Most README bytes worth reading for a tie-breaker. */
const README_TERM_BYTES = 256 * 1024

/**
 * The other half of a checkout's project context: what its README talks about.
 *
 * Bounded and best-effort: a missing, binary or enormous README contributes
 * nothing, and a term that is only prose simply never matches a utility's own
 * identity, so the scoring is unchanged where a README says nothing relevant.
 */
async function addReadmeTerms(terms: Set<string>, directory: string): Promise<void> {
  for (const name of ['README.md', 'readme.md', 'README']) {
    let raw: string
    try {
      raw = await readFile(join(directory, name), 'utf8')
    } catch {
      continue
    }
    addTerms(terms, raw.slice(0, README_TERM_BYTES))
    return
  }
}

/**
 * `cio_util_find`: rank this turn's snapshot against what the call asked for.
 *
 * Returns `undefined` when nothing in the snapshot matches and the turn has a
 * relay, which is the host forwarding the call to the app's own registry.
 */
export async function searchOvenUtilities(
  call: OvenUtilityLocalCall,
  value: OvenUtilityJson
): Promise<OvenUtilityJson | undefined> {
  const input = inputRecord(value)
  const query = optionalText(input, 'query') ?? ''
  const kinds = optionalKinds(input)
  const limit = Math.min(
    Math.max(optionalNumber(input, 'limit', SEARCH_LIMIT_DEFAULT), 1),
    SEARCH_LIMIT_MAXIMUM
  )
  const projectTerms = query ? await call.projectTerms() : new Set<string>()
  const active = call.state.activeIds()
  const ranked = [...call.catalogue.values()]
    .filter((utility) => !kinds || kinds.has(utility.kind))
    .map((utility) => ({
      utility,
      lexical: ovenUtilitySearchScore(utility, query),
      project: ovenUtilityProjectAffinity(utility, projectTerms)
    }))
    .sort((left, right) => right.lexical - left.lexical || right.project - left.project)
  const matches = query ? ranked.filter(({ lexical }) => lexical > 0) : ranked
  // Nothing matched by name, description, id or kind. The app owns the live
  // registry and may carry a capability installed moments ago that this snapshot
  // never had, so the call goes back through the turn's relay and the app's own
  // answer is what the agent sees — exactly what `/docs-lookup` already does for
  // an id the snapshot does not carry. Only a turn with no relay to ask is
  // answered here, and then `notFound` is the honest answer.
  if ((ranked.length === 0 || (query.length > 0 && matches.length === 0)) && call.turn.relayUrl)
    return undefined
  const fallback = query.length > 0 && matches.length === 0 && ranked.length > 0
  const utilities = (fallback ? ranked : matches).slice(0, limit).map(({ utility }) => ({
    id: utility.id,
    name: utility.name,
    kind: utility.kind,
    description: utility.description,
    active: active.has(utility.id)
  }))
  const notFound = ranked.length === 0
  return {
    utilities,
    fallback,
    notFound,
    matchType: notFound ? 'none' : fallback ? 'candidates' : 'direct',
    ...(fallback
      ? {
          message:
            'No direct match was found in the capabilities this turn carries. Review these candidates against the task intent, then activate a relevant result or refine the search. If none of them fits, the capability is not available on this Oven: say so plainly rather than guessing at an id.'
        }
      : {})
  }
}

/** How well one utility's own words match a query. Ported from the app's scoring. */
export function ovenUtilitySearchScore(utility: OvenUtilityTurnUtility, query: string): number {
  if (!query) return 0
  const normalizedQuery = normalize(query)
  const name = normalize(utility.name)
  const description = normalize(utility.description)
  const metadata = normalize(
    [utility.id, utility.kind, KIND_ALIASES[utility.kind] ?? ''].filter(Boolean).join(' ')
  )
  let score = 0
  if (name.includes(normalizedQuery)) score += 100
  if (description.includes(normalizedQuery)) score += 60
  if (metadata.includes(normalizedQuery)) score += 40
  for (const token of searchTokens(normalizedQuery)) {
    if (name.includes(token)) score += 12
    if (description.includes(token)) score += 6
    if (metadata.includes(token)) score += 3
  }
  return score
}

/**
 * A deterministic tie-breaker: prefer the utility whose own identity already
 * appears in the checkout the turn works in.
 */
export function ovenUtilityProjectAffinity(
  utility: OvenUtilityTurnUtility,
  projectTerms: ReadonlySet<string>
): number {
  if (projectTerms.size === 0) return 0
  const identity = searchTokens(normalize(`${utility.name} ${utility.id} ${utility.kind}`))
  return identity.reduce((score, token) => score + (projectTerms.has(token) ? 10 : 0), 0)
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function searchTokens(value: string): string[] {
  return [
    ...new Set(
      value
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter((token) => token.length > 2 && !STOP_WORDS.has(token)) ?? []
    )
  ]
}

function addTerms(terms: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return
  for (const token of value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (token.length <= 2) continue
    terms.add(token)
    if (token.endsWith('js') && token.length > 4) terms.add(token.slice(0, -2))
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
