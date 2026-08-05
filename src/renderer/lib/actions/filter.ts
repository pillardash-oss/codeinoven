import type { ActionDefinition, ActionFilterOptions } from './types'

interface RankedAction {
  action: ActionDefinition
  index: number
  score: number
}

const DEFAULT_LIMIT = 60

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}

function tokenize(value: string): string[] {
  return normalize(value).split(/\s+/u).filter(Boolean)
}

function wordStartsWith(value: string, token: string): boolean {
  return value.split(/[\s:/_.-]+/u).some((word) => word.startsWith(token))
}

function tokenScore(action: ActionDefinition, token: string): number | undefined {
  const title = normalize(action.title)
  const description = normalize(action.description ?? '')
  const category = normalize(action.category)
  const source = normalize(action.source.label)
  const keywords = (action.keywords ?? []).map(normalize)

  if (title === token) return 120
  if (title.startsWith(token)) return 100
  if (wordStartsWith(title, token)) return 84
  if (title.includes(token)) return 68
  if (keywords.some((keyword) => keyword === token)) return 58
  if (keywords.some((keyword) => keyword.startsWith(token))) return 52
  if (keywords.some((keyword) => keyword.includes(token))) return 46
  if (source.startsWith(token)) return 38
  if (category.startsWith(token)) return 34
  if (description.includes(token)) return 24

  return undefined
}

function rankAction(action: ActionDefinition, tokens: readonly string[]): number | undefined {
  if (tokens.length === 0) return 0

  let score = 0
  for (const token of tokens) {
    const currentScore = tokenScore(action, token)
    if (currentScore === undefined) return undefined
    score += currentScore
  }

  return score
}

export function filterActions(
  actions: readonly ActionDefinition[],
  query: string,
  options: ActionFilterOptions = {}
): ActionDefinition[] {
  const tokens = tokenize(query)
  const categories = options.categories ? new Set(options.categories) : undefined
  const sources = options.sources ? new Set(options.sources) : undefined
  const limit = Math.max(0, options.limit ?? DEFAULT_LIMIT)

  const ranked: RankedAction[] = []

  actions.forEach((action, index) => {
    if (categories && !categories.has(action.category)) return
    if (sources && !sources.has(action.source.id)) return

    const score = rankAction(action, tokens)
    if (score === undefined) return
    ranked.push({ action, index, score })
  })

  return ranked
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ action }) => action)
}
