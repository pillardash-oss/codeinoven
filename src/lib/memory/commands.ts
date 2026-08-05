import type { MemoryCategory, MemoryPriority, MemoryScope } from '../types'

export type MemoryCommandAction =
  'add' | 'list' | 'remove' | 'edit' | 'search' | 'help' | 'proposals' | 'approve' | 'reject'

export interface MemoryCommand {
  action: MemoryCommandAction
  label?: string
  content?: string
  category?: MemoryCategory
  priority?: MemoryPriority
  scope?: MemoryScope
  projectId?: string
  query?: string
  entryId?: string
  proposalId?: string
}

export interface ParseResult {
  valid: boolean
  command?: MemoryCommand
  error?: string
}

const CATEGORY_KEYWORDS: Record<string, MemoryCategory> = {
  behavioral: 'behavioral',
  behaviour: 'behavioral',
  rule: 'project-rule',
  'project-rule': 'project-rule',
  project: 'project-rule',
  identity: 'identity',
  preference: 'preference',
  pref: 'preference'
}

const PRIORITY_KEYWORDS: Record<string, MemoryPriority> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low'
}

const SCOPE_KEYWORDS: Record<string, MemoryScope> = {
  global: 'global',
  project: 'project',
  thread: 'thread',
  chat: 'chat'
}

/**
 * Parse a /memory command string into a structured command.
 * Format: /memory <action> [options] [label] [content]
 *
 * Actions:
 *   /memory add [--category X] [--priority X] [--scope X] <label> <content>
 *   /memory list [--category X] [--priority X]
 *   /memory remove <entry-id-or-label>
 *   /memory edit <entry-id-or-label> <new-content>
 *   /memory search <query>
 *   /memory proposals
 *   /memory approve <proposal-id>
 *   /memory reject <proposal-id>
 *   /memory help
 */
export function parseMemoryCommand(input: string): ParseResult {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/memory')) {
    return { valid: false, error: 'Not a /memory command' }
  }

  const parts = trimmed.split(/\s+/)
  if (parts.length < 2) {
    return { valid: true, command: { action: 'help' } }
  }

  const actionStr = parts[1].toLowerCase()
  const validActions: MemoryCommandAction[] = [
    'add',
    'list',
    'remove',
    'edit',
    'search',
    'help',
    'proposals',
    'approve',
    'reject'
  ]

  if (!validActions.includes(actionStr as MemoryCommandAction)) {
    return {
      valid: false,
      error: `Unknown action: ${actionStr}. Valid actions: ${validActions.join(', ')}`
    }
  }

  const action = actionStr as MemoryCommandAction
  const rest = parts.slice(2)

  if (action === 'help') {
    return { valid: true, command: { action: 'help' } }
  }

  if (action === 'list') {
    const opts = parseFlags(rest)
    return {
      valid: true,
      command: {
        action: 'list',
        category: opts.category,
        priority: opts.priority
      }
    }
  }

  if (action === 'search') {
    const query = rest.join(' ')
    if (!query) {
      return { valid: false, error: 'Search requires a query string' }
    }
    return { valid: true, command: { action: 'search', query } }
  }

  if (action === 'remove') {
    const idOrLabel = rest.join(' ')
    if (!idOrLabel) {
      return { valid: false, error: 'Remove requires an entry ID or label' }
    }
    return { valid: true, command: { action: 'remove', entryId: idOrLabel } }
  }

  if (action === 'approve' || action === 'reject') {
    const proposalId = rest.join(' ')
    if (!proposalId) {
      return { valid: false, error: `${action} requires a proposal ID` }
    }
    return { valid: true, command: { action, proposalId } }
  }

  if (action === 'proposals') {
    return { valid: true, command: { action: 'proposals' } }
  }

  if (action === 'edit') {
    const opts = parseFlags(rest)
    const positional = opts.positional
    if (positional.length < 2) {
      return { valid: false, error: 'Edit requires <entry-id-or-label> <new-content>' }
    }
    return {
      valid: true,
      command: {
        action: 'edit',
        entryId: positional[0],
        content: positional.slice(1).join(' ')
      }
    }
  }

  if (action === 'add') {
    const opts = parseFlags(rest)
    const positional = opts.positional
    if (positional.length < 2) {
      return { valid: false, error: 'Add requires <label> <content>' }
    }
    return {
      valid: true,
      command: {
        action: 'add',
        label: positional[0],
        content: positional.slice(1).join(' '),
        category: opts.category,
        priority: opts.priority,
        scope: opts.scope
      }
    }
  }

  return { valid: false, error: `Unhandled action: ${action}` }
}

interface ParsedFlags {
  positional: string[]
  category?: MemoryCategory
  priority?: MemoryPriority
  scope?: MemoryScope
}

function parseFlags(parts: string[]): ParsedFlags {
  const positional: string[] = []
  let category: MemoryCategory | undefined
  let priority: MemoryPriority | undefined
  let scope: MemoryScope | undefined

  let i = 0
  while (i < parts.length) {
    if (parts[i] === '--category' && i + 1 < parts.length) {
      category = CATEGORY_KEYWORDS[parts[i + 1].toLowerCase()]
      i += 2
    } else if (parts[i] === '--priority' && i + 1 < parts.length) {
      priority = PRIORITY_KEYWORDS[parts[i + 1].toLowerCase()]
      i += 2
    } else if (parts[i] === '--scope' && i + 1 < parts.length) {
      scope = SCOPE_KEYWORDS[parts[i + 1].toLowerCase()]
      i += 2
    } else {
      positional.push(parts[i])
      i++
    }
  }

  return { positional, category, priority, scope }
}

/** Generate help text for /memory commands. */
export function getMemoryHelpText(): string {
  return [
    '**Memory Commands:**',
    '',
    '`/memory add <label> <content>` — Add a new memory entry',
    '  Options: `--category behavioral|project-rule|identity|preference`',
    '           `--priority critical|high|medium|low`',
    '           `--scope global|project`',
    '',
    '`/memory list` — List all memory entries',
    '  Options: `--category <category>` `--priority <priority>`',
    '',
    '`/memory remove <id-or-label>` — Remove a memory entry',
    '',
    '`/memory edit <id-or-label> <new-content>` — Update entry content',
    '',
    '`/memory search <query>` — Search entries by keyword',
    '',
    '`/memory proposals` — View pending auto-detected memory proposals',
    '',
    '`/memory approve <proposal-id>` — Approve a pending proposal',
    '',
    '`/memory reject <proposal-id>` — Reject a pending proposal',
    '',
    '`/memory help` — Show this help text'
  ].join('\n')
}
