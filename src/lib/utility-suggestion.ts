/**
 * Contract for the app-owned `cio_util_suggest` gateway tool.
 *
 * The tool lets an agent propose a capability it found for the user to install:
 * a skill, an MCP server, or a plugin bundle of both. The app turns the proposal
 * into an actionable card on the canonical pending-question surface, and installs
 * the bundle through the Utilities registry on every harness only when the user
 * accepts. The bundle never carries a secret; a credential the capability needs
 * is collected afterwards with `cio_ask_secret`, exactly as for `install_bundle`.
 *
 * The proposal is validated against the registry before the card is shown, so a
 * card on screen is always installable: the user is never asked to approve
 * something the app already knows it cannot install. The card lists every
 * utility it would install, because installing software is a decision the user
 * makes with the tools in front of them, not against a bundle name.
 */

import type {
  AgentQuestion,
  AgentUtilitySuggestionEntry,
  UtilityDefinitionInput,
  UtilityKind
} from './types'

/**
 * Every kind instantiation of a definition input, as a discriminated union.
 * `UtilityDefinitionInput` instantiates its kind generic to the whole union, so
 * TypeScript cannot correlate `kind` with `config` on it; this restores that
 * correlation for the switch below, which then stays exhaustive.
 */
type KindedDefinition = { [Kind in UtilityKind]: UtilityDefinitionInput<Kind> }[UtilityKind]

function asKindedDefinition(definition: UtilityDefinitionInput): KindedDefinition {
  return definition as KindedDefinition
}

/**
 * One line naming where an installable utility points, so the approval card
 * shows what a server actually connects to instead of only its name. Never a
 * credential: only the transport and its destination, or the launch command.
 */
export function utilityInstallSource(definition: UtilityDefinitionInput): string {
  const kinded = asKindedDefinition(definition)
  switch (kinded.kind) {
    case 'mcp': {
      const { transport, url, command, args } = kinded.config
      const target =
        transport === 'stdio'
          ? [command, ...(args ?? [])].filter((part): part is string => Boolean(part)).join(' ')
          : url
      return target ? `${transport} · ${target}` : transport
    }
    case 'skill':
      return 'skill instructions'
    case 'web_search':
    case 'web_fetch': {
      const { provider, endpoint } = kinded.config
      return [provider ?? 'built-in', endpoint]
        .filter((part): part is string => Boolean(part))
        .join(' · ')
    }
    case 'computer_use': {
      const { backend, endpoint } = kinded.config
      return [backend, endpoint].filter((part): part is string => Boolean(part)).join(' · ')
    }
    case 'provider': {
      const { providerId, defaultModel } = kinded.config
      return [providerId, defaultModel].filter((part): part is string => Boolean(part)).join(' · ')
    }
    case 'image_descriptor': {
      const { harnessId, providerId, modelId } = kinded.config
      return `${harnessId} · ${providerId}/${modelId}`
    }
  }
}

/** What the user decided about one proposed capability. */
export type UtilitySuggestionDecision = 'accepted' | 'declined' | 'alternative'

/**
 * The user's full answer to a suggestion card. `alternative` carries the user's
 * own instruction, so a reply that is neither the install nor the decline option
 * (for example a server URL to use instead) reaches the agent as what the user
 * actually said rather than collapsing into a silent "no".
 */
export interface UtilitySuggestionResolution {
  decision: UtilitySuggestionDecision
  /** The user's own instruction; present only when the decision is `alternative`. */
  answer?: string
}

/** Option label that means "install the proposal". */
export const UTILITY_SUGGESTION_INSTALL_ANSWER = 'Install in CodeInOven'

/** Option label that means "do not install the proposal". */
export const UTILITY_SUGGESTION_DECLINE_ANSWER = 'Not now'

/**
 * The single question the suggestion card renders.
 *
 * The card offers the install and decline options plus the card's own free-text
 * field, so the user can answer with their own instruction when neither option
 * is what they mean. An abandoned or expired card still settles as a decline
 * rather than inventing consent, and free text never installs anything.
 */
export function utilitySuggestionQuestion(entry: AgentUtilitySuggestionEntry): AgentQuestion {
  const summary = entry.kinds.length > 0 ? ` (${entry.kinds.join(', ')})` : ''
  return {
    prompt: `Install ${entry.name}${summary}?`,
    header: 'Suggested capability',
    description: utilitySuggestionDescription(entry),
    richOptions: [
      {
        label: UTILITY_SUGGESTION_INSTALL_ANSWER,
        description: `Add ${entry.name} to Utilities so it is available on every harness, present and future.`
      },
      {
        label: UTILITY_SUGGESTION_DECLINE_ANSWER,
        description: 'Leave it out for now. You can install it yourself from Utilities later.'
      }
    ],
    utilitySuggestion: entry
  }
}

/**
 * The card body: the agent's own reason, then exactly what accepting installs.
 * Each utility is named with its kind and its install target, so an approval
 * screen never hides a server's address behind a bundle title.
 */
export function utilitySuggestionDescription(entry: AgentUtilitySuggestionEntry): string {
  const lines: string[] = [entry.reason.trim()]
  if (entry.utilities.length > 0) {
    lines.push('', `**Installs ${entry.utilities.length === 1 ? 'this tool' : 'these tools'}**`, '')
    for (const utility of entry.utilities) {
      const description = utility.description?.trim()
      lines.push(
        description
          ? `- **${utility.name}** (${utility.kind}): ${description}`
          : `- **${utility.name}** (${utility.kind})`
      )
      lines.push(`  \`${utility.source}\``)
    }
  }
  return lines.join('\n')
}

/**
 * Read the user's answer to a suggestion card.
 *
 * Selecting the install option accepts and selecting the decline option
 * declines. Any other submitted text is the user's own instruction, which is
 * handed to the agent word for word and never installs on its own.
 */
export function utilitySuggestionResolution(
  answers: readonly string[]
): UtilitySuggestionResolution {
  const answer = answers.find((value) => value.trim().length > 0)?.trim() ?? ''
  if (answer === UTILITY_SUGGESTION_INSTALL_ANSWER) return { decision: 'accepted' }
  if (answer === UTILITY_SUGGESTION_DECLINE_ANSWER) return { decision: 'declined' }
  return answer ? { decision: 'alternative', answer } : { decision: 'declined' }
}

/** Whether one pending question is an agent-proposed capability installation. */
export function isUtilitySuggestionQuestion(question: AgentQuestion): boolean {
  return question.utilitySuggestion !== undefined
}
