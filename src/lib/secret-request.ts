/**
 * Contract for the app-owned `cio_ask_secret` gateway tool.
 *
 * The tool accepts a short batch of secrets the agent cannot obtain itself. The
 * app turns each one into a question the user fills in a password card, stores
 * the value (encrypted vault, and a utility credential when the agent named a
 * capability), and answers the agent with the names it interpolates the value
 * under. A value never travels back through the tool result.
 */

import type { AgentQuestion } from './types'

/** Valid OS environment variable name a collected secret can be exposed under. */
export const SECRET_ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Most secrets one call may ask for; a card is human-paced, so keep it short. */
export const SECRET_REQUEST_LIMIT = 5

const SECRET_TITLE_LIMIT = 120
const SECRET_DESCRIPTION_LIMIT = 400
const ENVIRONMENT_VARIABLE_LIMIT = 64
const SECRET_TITLE_SLUG_LIMIT = 24

/** One secret an agent asked the user for, exactly as the tool input describes it. */
export interface AgentSecretRequest {
  title: string
  description?: string
  /** Variable the target expects; derived from the title when omitted. */
  environmentVariable?: string
  /** Installed utility to bind the value to as its credential. */
  utilityId?: string
}

/** One secret after the app assigned it an id and its final variable name. */
export interface AgentSecretPlanEntry {
  /** Stable id the card submits the value against. */
  id: string
  title: string
  description?: string
  environmentVariable: string
  utilityId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const text = value.trim()
  if (!text || text.length > maximum) throw new TypeError(`${label} is invalid`)
  return text
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined
  const text = boundedText(value, label, maximum)
  return text
}

/**
 * Validate the raw `cio_ask_secret` tool input. Rejects a batch that is empty,
 * oversized, or asks for the same environment variable twice, because the card
 * submits values by variable name and a duplicate would be ambiguous.
 */
export function normalizeAgentSecretRequests(input: unknown): AgentSecretRequest[] {
  if (!isRecord(input)) throw new TypeError('Secret request must be an object')
  const raw = input['secrets']
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SECRET_REQUEST_LIMIT) {
    throw new TypeError(`Secret request must contain between 1 and ${SECRET_REQUEST_LIMIT} secrets`)
  }
  const requests = raw.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`Secret ${index + 1} must be an object`)
    const title = boundedText(entry['title'], `Secret ${index + 1} title`, SECRET_TITLE_LIMIT)
    const description = optionalText(
      entry['description'],
      `Secret ${index + 1} description`,
      SECRET_DESCRIPTION_LIMIT
    )
    const environmentVariable = optionalText(
      entry['environment_variable'],
      `Secret ${index + 1} environment variable`,
      ENVIRONMENT_VARIABLE_LIMIT
    )
    if (
      environmentVariable !== undefined &&
      !SECRET_ENVIRONMENT_VARIABLE_PATTERN.test(environmentVariable)
    ) {
      throw new TypeError(
        `Secret ${index + 1} environment variable must be a valid OS variable name`
      )
    }
    const utilityId = optionalText(entry['utility_id'], `Secret ${index + 1} utility id`, 128)
    return {
      title,
      ...(description ? { description } : {}),
      ...(environmentVariable ? { environmentVariable } : {}),
      ...(utilityId ? { utilityId } : {})
    }
  })
  const explicitNames = requests
    .map((request) => request.environmentVariable?.toUpperCase())
    .filter((name): name is string => name !== undefined)
  if (new Set(explicitNames).size !== explicitNames.length) {
    throw new TypeError('Secret request must not ask for the same environment variable twice')
  }
  return requests
}

/**
 * Environment variable a collected secret is exposed under. An explicit name
 * always wins, because the target (an MCP server variable, a CLI flag) needs
 * that exact spelling; otherwise the app derives `CIO_<ID>_<TITLE_SLUG>`, where
 * the per-secret id keeps two secrets with the same title distinct.
 */
export function deriveSecretEnvironmentVariable(id: string, title: string): string {
  const slug = title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, SECRET_TITLE_SLUG_LIMIT)
    .replace(/_+$/gu, '')
  return `CIO_${id}_${slug || 'SECRET'}`
}

/**
 * Turn the validated batch into the questions the secret card renders. Each
 * question carries the id and the variable name the value will live under, so
 * the submission can be correlated without ever carrying the value back here.
 */
export function secretRequestQuestions(entries: readonly AgentSecretPlanEntry[]): AgentQuestion[] {
  return entries.map((entry) => ({
    prompt: entry.title,
    header: entry.title,
    ...(entry.description ? { description: entry.description } : {}),
    secretRequest: true,
    secretId: entry.id,
    secretEnvironmentVariable: entry.environmentVariable,
    ...(entry.utilityId ? { secretUtilityId: entry.utilityId } : {})
  }))
}
