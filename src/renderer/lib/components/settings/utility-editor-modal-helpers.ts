import type {
  HarnessUtilityBinding,
  McpUtilityConfig,
  UtilityActivation,
  UtilityConfigMap,
  UtilityCredentialInput,
  UtilityDefinition,
  UtilityKind,
  UtilityScope,
  WebToolProviderId
} from '$shared/types'
import { ALL_HARNESSES_BINDING_ID } from '$shared/types'

export type ScopeLevel = UtilityScope['level']
export type BindingStrategy = HarnessUtilityBinding['strategy']

export interface BindingDraft {
  harnessId: string
  strategy: BindingStrategy
  nativeCapability: string
  transportName: string
}

export interface UtilityDraft {
  id: string | null
  kind: UtilityKind
  name: string
  description: string
  enabled: boolean
  activation: UtilityActivation
  scopeLevel: ScopeLevel
  projectId: string
  threadId: string
  transport: 'stdio' | 'http' | 'sse'
  command: string
  args: string
  url: string
  environment: string
  instructions: string
  supportingFiles: string
  endpoint: string
  headers: string
  provider: WebToolProviderId
  backend: string
  providerId: string
  defaultModel: string
  descriptorHarnessId: string
  descriptorProviderId: string
  descriptorModelId: string
  bindings: BindingDraft[]
}

export interface CredentialDraft {
  id: string
  label: string
  value: string
  required: boolean
  environmentVariable: string
}

export const skillPlaceholder = `---
name: my-skill
description: What this skill helps with
---

# Instructions

Write the skill…`

export function emptyDraft(): UtilityDraft {
  return {
    id: null,
    kind: 'mcp',
    name: '',
    description: '',
    enabled: true,
    activation: 'on_demand',
    scopeLevel: 'global',
    projectId: '',
    threadId: '',
    transport: 'stdio',
    command: '',
    args: '',
    url: '',
    environment: '',
    instructions: '',
    supportingFiles: '',
    endpoint: '',
    headers: '',
    provider: 'custom',
    backend: '',
    providerId: '',
    defaultModel: '',
    descriptorHarnessId: '',
    descriptorProviderId: '',
    descriptorModelId: '',
    bindings: []
  }
}

export function skillDocument(name: string, description: string, instructions: string): string {
  if (instructions.trimStart().startsWith('---')) return instructions
  return `---
name: ${name}
description: ${description || 'Describe when an agent should use this skill.'}
---

${instructions}`
}

export function skillMetadata(markdown: string): { name: string; description: string } {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/u)
  if (!match?.[1]) {
    throw new Error('SKILL.md must begin with frontmatter containing name and description.')
  }
  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    fields[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
  }
  const name = fields['name'] ?? ''
  const description = fields['description'] ?? ''
  if (!name) throw new Error('SKILL.md frontmatter requires a name.')
  if (!description) throw new Error('SKILL.md frontmatter requires a description.')
  return { name, description }
}

export function allHarnessBinding(
  strategy: BindingStrategy,
  nativeCapability: string,
  transportName: string
): BindingDraft[] {
  return [
    {
      harnessId: ALL_HARNESSES_BINDING_ID,
      strategy,
      nativeCapability,
      transportName
    }
  ]
}

export function newBinding(draft: UtilityDraft, harnessId: string): BindingDraft {
  return {
    harnessId,
    strategy:
      draft.kind === 'skill' ? 'skill' : draft.kind === 'image_descriptor' ? 'native' : 'mcp',
    nativeCapability:
      draft.kind === 'web_search' || draft.kind === 'web_fetch'
        ? draft.kind
        : draft.kind === 'image_descriptor'
          ? 'image_descriptor'
          : '',
    transportName:
      draft.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-|-$/gu, '') || 'utility'
  }
}

export function setAllHarnessBindings(draft: UtilityDraft): void {
  draft.bindings = [newBinding(draft, ALL_HARNESSES_BINDING_ID)]
}

export function toggleHarnessBinding(draft: UtilityDraft, harnessId: string): void {
  const existing = draft.bindings.find((binding) => binding.harnessId === harnessId)
  if (existing) {
    draft.bindings = draft.bindings.filter((binding) => binding.harnessId !== harnessId)
    return
  }
  draft.bindings = [
    ...draft.bindings.filter((binding) => binding.harnessId !== ALL_HARNESSES_BINDING_ID),
    newBinding(draft, harnessId)
  ]
}

export function setScopeLevel(draft: UtilityDraft, level: ScopeLevel): void {
  draft.scopeLevel = level
  if (level === 'global') {
    draft.projectId = ''
    draft.threadId = ''
  } else if (level === 'project') {
    draft.threadId = ''
  }
}

export function setScopeProject(draft: UtilityDraft, projectId: string): void {
  draft.projectId = projectId
  draft.threadId = ''
}

export function parseRecord(value: string, label: string): Record<string, string> | undefined {
  if (!value.trim()) return undefined
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`)
  }
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== 'string') throw new Error(`${label} values must be strings.`)
    result[key] = item
  }
  return result
}

export function buildScope(draft: UtilityDraft): UtilityScope {
  if (draft.scopeLevel === 'global') return { level: 'global' }
  if (!draft.projectId.trim()) throw new Error('Project ID is required.')
  if (draft.scopeLevel === 'project') {
    return { level: 'project', projectId: draft.projectId.trim() }
  }
  if (!draft.threadId.trim()) throw new Error('Thread ID is required.')
  return {
    level: 'thread',
    projectId: draft.projectId.trim(),
    threadId: draft.threadId.trim()
  }
}

/**
 * An MCP server always loads on demand: the app starts it inside the turn the
 * agent activates it, behind the utility gateway, and never writes a native MCP
 * entry into a harness or project config. The editor fixes the value, and this
 * guards the save path against a stale draft.
 */
export function effectiveActivation(draft: UtilityDraft): UtilityActivation {
  return draft.kind === 'mcp' ? 'on_demand' : draft.activation
}

export function buildConfig(draft: UtilityDraft): UtilityConfigMap[UtilityKind] {
  switch (draft.kind) {
    case 'mcp':
      return buildMcpConnectionConfig(draft)
    case 'skill':
      return { instructions: draft.instructions.trim() }
    case 'web_search':
    case 'web_fetch': {
      const headers = parseRecord(draft.headers, 'Headers')
      return {
        ...(draft.provider !== 'custom' ? { provider: draft.provider } : {}),
        ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
        ...(headers ? { headers } : {})
      }
    }
    case 'computer_use':
      return {
        backend: draft.backend.trim(),
        ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {})
      }
    case 'provider':
      return {
        providerId: draft.providerId.trim(),
        ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
        ...(draft.defaultModel.trim() ? { defaultModel: draft.defaultModel.trim() } : {})
      }
    case 'image_descriptor':
      return {
        harnessId: draft.descriptorHarnessId.trim(),
        providerId: draft.descriptorProviderId.trim(),
        modelId: draft.descriptorModelId.trim()
      }
  }
}

/**
 * The MCP connection a draft describes. Shared by the save path and the
 * connection test, so a tested draft is the configuration that would be saved.
 */
export function buildMcpConnectionConfig(draft: UtilityDraft): McpUtilityConfig {
  const environment = parseRecord(draft.environment, 'Environment')
  const headers = parseRecord(draft.headers, 'Headers')
  return {
    transport: draft.transport,
    ...(draft.command.trim() ? { command: draft.command.trim() } : {}),
    ...(draft.args.trim()
      ? {
          args: draft.args
            .split('\n')
            .map((item) => item.trim())
            .filter(Boolean)
        }
      : {}),
    ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
    ...(environment ? { environment } : {}),
    ...(headers ? { headers } : {})
  }
}

export function buildBindings(
  draft: UtilityDraft,
  installedHarnessIds: string[]
): HarnessUtilityBinding[] {
  const installedIds = new Set(installedHarnessIds)
  return draft.bindings
    .filter((binding) => binding.harnessId.trim())
    .filter(
      (binding) =>
        draft.id !== null ||
        binding.harnessId === ALL_HARNESSES_BINDING_ID ||
        installedIds.has(binding.harnessId)
    )
    .map((binding) => ({
      harnessId: binding.harnessId.trim(),
      strategy: binding.strategy,
      ...(binding.nativeCapability.trim()
        ? { nativeCapability: binding.nativeCapability.trim() }
        : {}),
      ...(binding.transportName.trim() ? { transportName: binding.transportName.trim() } : {})
    }))
}

/**
 * The secret the user is writing. `credential.id` is the identity of the
 * credential being replaced, so a form that keeps editing the first credential
 * cannot silently rewrite another one: leave the id empty to register a new
 * credential, whose id is derived from its variable name instead.
 */
export function buildCredential(
  draft: UtilityDraft,
  credential: CredentialDraft
): UtilityCredentialInput | null {
  if (!credential.value) return null
  const webUtility = draft.kind === 'web_search' || draft.kind === 'web_fetch'
  const environmentVariable =
    credential.environmentVariable.trim() || (webUtility ? 'WEB_API_KEY' : '')
  if (!environmentVariable) throw new Error('Environment variable is required for an MCP secret.')
  const id =
    credential.id.trim() ||
    environmentVariable
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '')
  const label =
    credential.label.trim() || (webUtility ? 'Web API key' : `${environmentVariable} secret`)
  return {
    id,
    label,
    value: credential.value,
    required: credential.required,
    environmentVariable
  }
}

/** Map a stored registry utility back onto an editable draft. */
export function utilityToDraft(utility: UtilityDefinition): UtilityDraft {
  const next = emptyDraft()
  next.id = utility.id
  next.kind = utility.kind
  next.name = utility.name
  next.description = utility.description
  next.enabled = utility.enabled
  next.activation = utility.activation
  next.scopeLevel = utility.scope.level
  next.projectId = utility.scope.level === 'global' ? '' : utility.scope.projectId
  next.threadId = utility.scope.level === 'thread' ? utility.scope.threadId : ''
  next.bindings = utility.harnessBindings.map((binding) => ({
    harnessId: binding.harnessId,
    strategy: binding.strategy,
    nativeCapability: binding.nativeCapability ?? '',
    transportName: binding.transportName ?? ''
  }))
  switch (utility.kind) {
    case 'mcp':
      next.transport = utility.config.transport
      next.command = utility.config.command ?? ''
      next.args = utility.config.args?.join('\n') ?? ''
      next.url = utility.config.url ?? ''
      next.environment = utility.config.environment
        ? JSON.stringify(utility.config.environment, null, 2)
        : ''
      next.headers = utility.config.headers ? JSON.stringify(utility.config.headers, null, 2) : ''
      break
    case 'skill':
      next.instructions = skillDocument(
        utility.name,
        utility.description,
        utility.config.instructions
      )
      next.supportingFiles = utility.config.supportingFiles?.join('\n') ?? ''
      break
    case 'web_search':
    case 'web_fetch':
      next.provider = utility.config.provider ?? 'custom'
      next.endpoint = utility.config.endpoint ?? ''
      next.headers = utility.config.headers ? JSON.stringify(utility.config.headers, null, 2) : ''
      break
    case 'computer_use':
      next.backend = utility.config.backend
      next.endpoint = utility.config.endpoint ?? ''
      break
    case 'provider':
      next.providerId = utility.config.providerId
      next.endpoint = utility.config.endpoint ?? ''
      next.defaultModel = utility.config.defaultModel ?? ''
      break
    case 'image_descriptor':
      next.descriptorHarnessId = utility.config.harnessId
      next.descriptorProviderId = utility.config.providerId
      next.descriptorModelId = utility.config.modelId
      break
  }
  return next
}
