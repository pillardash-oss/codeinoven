import { access, readFile } from 'fs/promises'
import { join } from 'path'
import type { ResolvedUtility, UtilityDefinition, UtilityKind } from '../../../lib/types'
import { isRecord } from './utility-input'

const UTILITY_SEARCH_STOP_WORDS = new Set([
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
const PROJECT_TECH_MARKERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['svelte.config.js', ['svelte', 'sveltekit']],
  ['svelte.config.ts', ['svelte', 'sveltekit']],
  ['next.config.js', ['next', 'nextjs', 'react']],
  ['next.config.mjs', ['next', 'nextjs', 'react']],
  ['nuxt.config.js', ['nuxt', 'vue']],
  ['nuxt.config.ts', ['nuxt', 'vue']],
  ['angular.json', ['angular']],
  ['Cargo.toml', ['cargo', 'rust']],
  ['go.mod', ['go', 'golang']],
  ['pyproject.toml', ['python']],
  ['requirements.txt', ['python']],
  ['Gemfile', ['ruby']],
  ['composer.json', ['php']]
]

export function normalizeCapability(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s-]+/gu, '_')
}

export function operationPid(input: Record<string, unknown>): number | null {
  const directPid = input['pid']
  if (typeof directPid === 'number' && Number.isInteger(directPid) && directPid > 0) {
    return directPid
  }
  const target = isRecord(input['target']) ? input['target'] : {}
  const targetPid = target['pid']
  return typeof targetPid === 'number' && Number.isInteger(targetPid) && targetPid > 0
    ? targetPid
    : null
}
export function matchesUtilityKinds(
  { utility, binding }: ResolvedUtility,
  kinds: Set<UtilityKind> | null
): boolean {
  if (!kinds || kinds.has(utility.kind)) return true
  if (!binding.nativeCapability) return false
  const capability = normalizeCapability(binding.nativeCapability)
  return [...kinds].some((kind) => normalizeCapability(kind) === capability)
}

export function utilitySearchScore({ utility, binding }: ResolvedUtility, query: string): number {
  if (!query) return 0
  const normalizedQuery = normalizeSearchText(query)
  const name = normalizeSearchText(utility.name)
  const description = normalizeSearchText(utility.description)
  const metadata = normalizeSearchText(
    [
      utility.id,
      utility.kind,
      binding.nativeCapability,
      binding.transportName,
      utilitySearchConfiguration(utility),
      utilitySearchAliases(utility.kind, binding.nativeCapability)
    ]
      .filter((value): value is string => Boolean(value))
      .join(' ')
  )
  let score = 0
  if (name.includes(normalizedQuery)) score += 100
  if (description.includes(normalizedQuery)) score += 60
  if (metadata.includes(normalizedQuery)) score += 40

  const tokens = searchTokens(normalizedQuery)
  for (const token of tokens) {
    if (name.includes(token)) score += 12
    if (description.includes(token)) score += 6
    if (metadata.includes(token)) score += 3
  }
  return score
}

/** Prefer utilities whose identity is already present in the current project's
 *  root manifests. This is a deterministic tie-breaker for intent queries, not
 *  a replacement for explicit query matches. */
export function utilityProjectAffinityScore(
  { utility, binding }: ResolvedUtility,
  projectTerms: ReadonlySet<string>
): number {
  if (projectTerms.size === 0) return 0
  const identity = searchTokens(
    normalizeSearchText(
      [
        utility.name,
        utility.id,
        binding.nativeCapability,
        binding.transportName,
        utilitySearchConfiguration(utility)
      ]
        .filter((value): value is string => Boolean(value))
        .join(' ')
    )
  )
  return identity.reduce((score, token) => score + (projectTerms.has(token) ? 10 : 0), 0)
}

/** Non-secret identifiers that often carry the strongest MCP/provider name
 *  even when a utility's human-authored description is sparse. */
function utilitySearchConfiguration(utility: UtilityDefinition): string {
  switch (utility.kind) {
    case 'mcp':
      return [utility.config.command, ...(utility.config.args ?? []), utility.config.url]
        .filter((value): value is string => Boolean(value))
        .join(' ')
    case 'skill':
      return utility.config.supportingFiles?.join(' ') ?? ''
    case 'web_search':
    case 'web_fetch':
      return [utility.config.provider, utility.config.endpoint]
        .filter((value): value is string => Boolean(value))
        .join(' ')
    case 'computer_use':
      return [utility.config.backend, utility.config.endpoint]
        .filter((value): value is string => Boolean(value))
        .join(' ')
    case 'provider':
      return [utility.config.providerId, utility.config.defaultModel, utility.config.endpoint]
        .filter((value): value is string => Boolean(value))
        .join(' ')
    case 'image_descriptor':
      return [utility.config.harnessId, utility.config.providerId, utility.config.modelId].join(' ')
  }
}

function utilitySearchAliases(kind: UtilityKind, nativeCapability?: string): string {
  const aliases: string[] = []
  if (normalizeCapability(nativeCapability ?? '') === 'scope') {
    aliases.push(
      'scope worktree work tree checkout isolate isolated separate parallel branch sandbox copy clone git repository working directory'
    )
  }
  if (normalizeCapability(nativeCapability ?? '') === 'computer_use') {
    aliases.push(
      'computer desktop screen mouse keyboard click type scroll gui ui application app browser chrome safari firefox visual automation control interact open launch'
    )
  }
  if (kind === 'mcp') aliases.push('mcp integration connector server external tools')
  if (kind === 'skill') aliases.push('skill instructions workflow knowledge procedure')
  if (kind === 'web_search') aliases.push('web internet online search research lookup')
  if (kind === 'web_fetch') aliases.push('web internet url page website fetch read download')
  if (kind === 'computer_use') {
    aliases.push(
      'computer desktop screen mouse keyboard click type scroll gui ui application app browser chrome safari firefox visual automation control interact open launch'
    )
  }
  if (kind === 'provider') aliases.push('provider model api inference')
  if (kind === 'image_descriptor') {
    aliases.push(
      'image descriptor describe vision picture photo screenshot see look visual ocr caption alt text'
    )
  }
  return aliases.join(' ')
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function searchTokens(value: string): string[] {
  return [
    ...new Set(
      value
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter((token) => token.length > 2 && !UTILITY_SEARCH_STOP_WORDS.has(token)) ?? []
    )
  ]
}

/** Read only bounded root-level technology signals. Search stays local and
 *  deterministic, while package names let an intent-only query favor the MCP
 *  that matches the project stack. */
export async function projectTechnologyTerms(projectPath: string): Promise<Set<string>> {
  const terms = new Set<string>()
  const packageJsonPath = join(projectPath, 'package.json')
  try {
    const raw = await readFile(packageJsonPath, 'utf8')
    if (raw.length <= 1_000_000) {
      const parsed: unknown = JSON.parse(raw)
      if (isRecord(parsed)) {
        addProjectPackageTerms(terms, parsed['name'])
        for (const field of [
          'dependencies',
          'devDependencies',
          'peerDependencies',
          'optionalDependencies'
        ]) {
          const dependencies = parsed[field]
          if (!isRecord(dependencies)) continue
          for (const packageName of Object.keys(dependencies)) {
            addProjectPackageTerms(terms, packageName)
          }
        }
      }
    }
  } catch {
    // A missing or malformed package manifest simply contributes no signals.
  }

  await Promise.all(
    PROJECT_TECH_MARKERS.map(async ([filename, markerTerms]) => {
      try {
        await access(join(projectPath, filename))
        for (const term of markerTerms) terms.add(term)
      } catch {
        // Most projects have only one or two of these markers.
      }
    })
  )
  return terms
}

function addProjectPackageTerms(terms: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return
  for (const token of value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (token.length <= 2) continue
    terms.add(token)
    if (token.endsWith('js') && token.length > 4) terms.add(token.slice(0, -2))
  }
}
