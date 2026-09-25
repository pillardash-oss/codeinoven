/**
 * Input parsing for the scope capability.
 *
 * Every field the capability accepts is validated here, and unknown fields are
 * rejected rather than ignored, so a model's typo can never look like a
 * successful request for something else. The schemas and the error wording are
 * part of the tool contract and must stay byte-identical.
 */

import { SCOPE_TOOL_ACTIONS } from '../../../lib/types'
import type {
  GitPullStrategy,
  ScopeEnvironmentMode,
  ScopeMergeMode,
  ScopeSetupCommandSpec,
  ScopeToolAction
} from '../../../lib/types'
import { APP_SCOPE_UTILITY_ID } from '../../../lib/utility-ids'
import type { ScopeToolCall } from './scope-tool-types'

const MAX_TITLE_LENGTH = 120
const MAX_NAME_LENGTH = 80
const MAX_PATH_LENGTH = 4096
const MAX_REFERENCE_LENGTH = 200

export const STRATEGIES: readonly GitPullStrategy[] = ['merge', 'rebase', 'ff-only']
export const MERGE_MODES: readonly ScopeMergeMode[] = [
  'merge-keep',
  'merge-delete',
  'merge-move-to-default'
]
export const ENVIRONMENT_MODES: readonly ScopeEnvironmentMode[] = ['copy', 'symlink']
export const THREAD_DISPOSITIONS = ['move-to-default', 'delete'] as const

/** Every field the scope capability accepts; anything else is rejected, never ignored. */
const SCOPE_TOOL_INPUT_KEYS: ReadonlySet<string> = new Set([
  'action',
  'scope',
  'title',
  'name',
  'baseBranch',
  'runSetup',
  'environmentMode',
  'setupCommands',
  'attachThread',
  'sourcePath',
  'strategy',
  'mode',
  'target',
  'deleteBranch',
  'threads',
  'confirm'
])

/**
 * Normalize raw tool input into a validated call. Unknown fields are rejected
 * rather than ignored, so a model's typo can never look like a successful
 * request for something else.
 */
export function parseScopeToolInput(input: Record<string, unknown>): ScopeToolCall {
  for (const key of Object.keys(input)) {
    if (!SCOPE_TOOL_INPUT_KEYS.has(key)) {
      throw new TypeError(`Unsupported ${APP_SCOPE_UTILITY_ID} input field: ${key}`)
    }
  }
  const rawAction = input['action']
  if (typeof rawAction !== 'string' || !rawAction.trim()) {
    throw new TypeError('action is required')
  }
  const action = rawAction.trim()
  if (!(SCOPE_TOOL_ACTIONS as readonly string[]).includes(action)) {
    throw new TypeError(
      `Unsupported action “${action}”. Use one of: ${SCOPE_TOOL_ACTIONS.join(', ')}`
    )
  }
  const call: ScopeToolCall = { action: action as ScopeToolAction }
  const scope = optionalString(input, 'scope', MAX_REFERENCE_LENGTH)
  if (scope !== undefined) call.scope = scope
  const title = optionalString(input, 'title', MAX_TITLE_LENGTH)
  if (title !== undefined) call.title = title
  const name = optionalString(input, 'name', MAX_NAME_LENGTH)
  if (name !== undefined) call.name = name
  const baseBranch = optionalString(input, 'baseBranch', MAX_REFERENCE_LENGTH)
  if (baseBranch !== undefined) call.baseBranch = baseBranch
  const sourcePath = optionalString(input, 'sourcePath', MAX_PATH_LENGTH)
  if (sourcePath !== undefined) call.sourcePath = sourcePath
  const target = optionalString(input, 'target', MAX_REFERENCE_LENGTH)
  if (target !== undefined) call.target = target
  const runSetup = optionalBoolean(input, 'runSetup')
  if (runSetup !== undefined) call.runSetup = runSetup
  const attachThread = optionalBoolean(input, 'attachThread')
  if (attachThread !== undefined) call.attachThread = attachThread
  const deleteBranch = optionalBoolean(input, 'deleteBranch')
  if (deleteBranch !== undefined) call.deleteBranch = deleteBranch
  const confirm = optionalBoolean(input, 'confirm')
  if (confirm !== undefined) call.confirm = confirm
  const environmentMode = optionalEnum(input, 'environmentMode', ENVIRONMENT_MODES)
  if (environmentMode !== undefined) call.environmentMode = environmentMode
  const strategy = optionalEnum(input, 'strategy', STRATEGIES)
  if (strategy !== undefined) call.strategy = strategy
  const mode = optionalEnum(input, 'mode', MERGE_MODES)
  if (mode !== undefined) call.mode = mode
  const threads = optionalEnum(input, 'threads', THREAD_DISPOSITIONS)
  if (threads !== undefined) call.threads = threads
  const setupCommands = parseSetupCommands(input['setupCommands'])
  if (setupCommands !== undefined) call.setupCommands = setupCommands
  return call
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  maxLength: number
): string | undefined {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > maxLength) {
    throw new TypeError(`${key} must be at most ${maxLength} characters`)
  }
  return trimmed
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`)
  return value
}

function optionalEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${key} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

function parseSetupCommands(value: unknown): ScopeSetupCommandSpec[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new TypeError('setupCommands must be an array')
  if (value.length > 20) throw new TypeError('setupCommands must contain at most 20 commands')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TypeError(`setupCommands entry ${index} must be an object`)
    }
    const record = entry as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (key !== 'executable' && key !== 'args') {
        throw new TypeError(`setupCommands entry ${index} has an unsupported field: ${key}`)
      }
    }
    const executable = optionalString(record, 'executable', MAX_PATH_LENGTH)
    if (!executable) throw new TypeError(`setupCommands entry ${index} needs an executable`)
    const args = record['args']
    if (args !== undefined && !Array.isArray(args)) {
      throw new TypeError(`setupCommands entry ${index} args must be an array`)
    }
    return {
      executable,
      args: ((args as unknown[] | undefined) ?? []).map((arg, argIndex) => {
        if (typeof arg !== 'string') {
          throw new TypeError(`setupCommands entry ${index} argument ${argIndex} must be a string`)
        }
        return arg
      })
    }
  })
}
