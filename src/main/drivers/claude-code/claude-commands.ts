import type { HarnessCommand } from '../../../lib/types'
import type { SendPromptOptions } from '../driver.interface'

/** Claude Code non-interactive command catalog and effort mapping. */

/** Commands Claude Code documents as usable without its interactive TUI. */
export const CLAUDE_NON_INTERACTIVE_COMMANDS: readonly HarnessCommand[] = [
  { name: 'compact', description: 'Summarize older history to free context' },
  { name: 'config', description: 'Set Claude Code preferences with key=value arguments' },
  { name: 'settings', description: 'Set Claude Code preferences with key=value arguments' },
  {
    name: 'usage-credits',
    description: 'Switch this session to pay-as-you-go API usage credits'
  }
]

export const CLAUDE_COMMANDS_REQUIRING_ARGUMENTS = new Set(['config', 'settings'])

export function utilityKey(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'utility'
  )
}

export function claudeEffort(value: SendPromptOptions['settings']['thinkingLevel']): string {
  if (value === 'minimal') return 'low'
  if (value === 'ultra') return 'max'
  return value
}
