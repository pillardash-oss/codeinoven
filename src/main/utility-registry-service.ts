import type {
  HarnessUtilityBinding,
  ResolvedUtility,
  UtilityActivation,
  UtilityConfigMap,
  UtilityCredentialMetadata,
  UtilityDefinition,
  UtilityDefinitionInput,
  UtilityDefinitionPatch,
  UtilityKind,
  UtilityResolutionContext,
  UtilityScope,
  UtilitySearchOptions,
  WebToolProviderId
} from '../lib/types'
import { UTILITY_KIND_VALUES } from '../lib/types'
import { generateId } from '../lib/utils'
import type { StorageEngine } from './storage-engine'

const REGISTRY_PATH = 'utilities/registry.json'
const REGISTRY_VERSION = 1
const UTILITY_KINDS = new Set<UtilityKind>(UTILITY_KIND_VALUES)
const ACTIVATIONS = new Set<UtilityActivation>(['on_demand', 'always'])
const BINDING_STRATEGIES = new Set<HarnessUtilityBinding['strategy']>([
  'native',
  'mcp',
  'skill',
  'environment',
  'provider'
])
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u
const SENSITIVE_CONFIG_KEY = /(api[-_]?key|authorization|credential|password|secret|token)/iu
const WEB_TOOL_PROVIDERS = new Set<WebToolProviderId>(['exa', 'firecrawl', 'brave', 'custom'])

interface UtilityRegistryFile {
  version: number
  utilities: UtilityDefinition[]
}

/**
 * Persists utility metadata under CodeInOven's config root and resolves only
 * the capabilities needed for one harness turn. Secret values are never
 * accepted here; credential records contain opaque vault references.
 */
export class UtilityRegistryService {
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly storage: StorageEngine) {}

  async list(): Promise<UtilityDefinition[]> {
    return structuredClone((await this.load()).utilities)
  }

  async get(id: string): Promise<UtilityDefinition | null> {
    assertId(id, 'Utility ID')
    const utility = (await this.load()).utilities.find((candidate) => candidate.id === id)
    return utility ? structuredClone(utility) : null
  }

  async create(input: UtilityDefinitionInput): Promise<UtilityDefinition> {
    const normalized = normalizeInput(input)
    return this.mutate(async (registry) => {
      const now = Date.now()
      const utility = {
        ...normalized,
        id: generateId(),
        createdAt: now,
        updatedAt: now
      } as UtilityDefinition
      registry.utilities.push(utility)
      return structuredClone(utility)
    })
  }

  async createMany(inputs: UtilityDefinitionInput[]): Promise<UtilityDefinition[]> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new TypeError('Utility bundle must contain at least one utility')
    }
    const normalized = inputs.map((input) => normalizeInput(input))
    return this.mutate(async (registry) => {
      const now = Date.now()
      const utilities = normalized.map(
        (input) =>
          ({
            ...input,
            id: generateId(),
            createdAt: now,
            updatedAt: now
          }) as UtilityDefinition
      )
      registry.utilities.push(...utilities)
      return structuredClone(utilities)
    })
  }

  async update(id: string, patch: UtilityDefinitionPatch): Promise<UtilityDefinition> {
    assertId(id, 'Utility ID')
    assertUpdate(patch)
    return this.mutate(async (registry) => {
      const index = registry.utilities.findIndex((candidate) => candidate.id === id)
      const current = registry.utilities[index]
      if (!current) throw new Error(`Utility not found: ${id}`)

      const normalized = normalizeInput({
        kind: current.kind,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        enabled: patch.enabled ?? current.enabled,
        activation: patch.activation ?? current.activation,
        scope: patch.scope ?? current.scope,
        config: patch.config ?? current.config,
        credentials: patch.credentials ?? current.credentials,
        harnessBindings: patch.harnessBindings ?? current.harnessBindings
      })
      const updated = {
        ...normalized,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: Date.now()
      } as UtilityDefinition
      registry.utilities[index] = updated
      return structuredClone(updated)
    })
  }

  async delete(id: string): Promise<boolean> {
    assertId(id, 'Utility ID')
    return this.mutate(async (registry) => {
      const index = registry.utilities.findIndex((candidate) => candidate.id === id)
      if (index === -1) return false
      registry.utilities.splice(index, 1)
      return true
    })
  }

  async search(options: UtilitySearchOptions = {}): Promise<UtilityDefinition[]> {
    assertSearchOptions(options)
    const query = options.query?.trim().toLocaleLowerCase() ?? ''
    const kindSet = options.kinds ? new Set(options.kinds) : null
    return (await this.list())
      .filter((utility) => !kindSet || kindSet.has(utility.kind))
      .filter((utility) => options.enabled === undefined || utility.enabled === options.enabled)
      .filter((utility) => !options.scope || scopesEqual(utility.scope, options.scope))
      .filter((utility) => {
        if (!query) return true
        return [utility.name, utility.description, utility.kind].some((value) =>
          value.toLocaleLowerCase().includes(query)
        )
      })
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async resolve(context: UtilityResolutionContext): Promise<ResolvedUtility[]> {
    assertResolutionContext(context)
    const resolvedCapabilities = new Set(
      (context.nativeCapabilities ?? []).map(normalizeCapability)
    )
    const resolved: ResolvedUtility[] = []
    const candidates = (await this.list())
      .filter((utility) => utility.enabled && scopeApplies(utility.scope, context))
      .filter(
        (utility) =>
          utility.activation === 'always' ||
          context.includeOnDemand === true ||
          matchesTaskQuery(utility, context.query)
      )
      .sort(
        (left, right) =>
          scopeRank(right.scope) - scopeRank(left.scope) || left.name.localeCompare(right.name)
      )

    for (const utility of candidates) {
      const binding = utility.harnessBindings.find(
        (candidate) => candidate.harnessId === context.harnessId
      )
      if (!binding) continue

      const implicitCapability =
        utility.kind === 'web_search' ||
        utility.kind === 'web_fetch' ||
        utility.kind === 'computer_use'
          ? utility.kind
          : undefined
      const capability = binding.nativeCapability
        ? normalizeCapability(binding.nativeCapability)
        : implicitCapability
      if (capability && resolvedCapabilities.has(capability)) continue
      if (capability) resolvedCapabilities.add(capability)
      resolved.push({ utility, binding })
    }

    return resolved.sort(
      (left, right) =>
        scopeRank(right.utility.scope) - scopeRank(left.utility.scope) ||
        left.utility.name.localeCompare(right.utility.name)
    )
  }

  private async load(): Promise<UtilityRegistryFile> {
    const stored = await this.storage.read<unknown>(REGISTRY_PATH)
    if (stored === null) return { version: REGISTRY_VERSION, utilities: [] }
    return parseRegistry(stored)
  }

  private async mutate<Result>(
    operation: (registry: UtilityRegistryFile) => Promise<Result>
  ): Promise<Result> {
    const previous = this.mutationQueue
    let release: (() => void) | undefined
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      const registry = await this.load()
      const result = await operation(registry)
      await this.storage.write(REGISTRY_PATH, registry)
      return result
    } finally {
      release?.()
    }
  }
}

function parseRegistry(value: unknown): UtilityRegistryFile {
  if (
    !isRecord(value) ||
    value['version'] !== REGISTRY_VERSION ||
    !Array.isArray(value['utilities'])
  ) {
    throw new Error('Utility registry is corrupt or uses an unsupported version')
  }
  const utilities = value['utilities'].map((utility, index) => parseStoredUtility(utility, index))
  const ids = new Set<string>()
  for (const utility of utilities) {
    if (ids.has(utility.id))
      throw new Error(`Utility registry contains duplicate ID: ${utility.id}`)
    ids.add(utility.id)
  }
  return { version: REGISTRY_VERSION, utilities }
}

function parseStoredUtility(value: unknown, index: number): UtilityDefinition {
  if (!isRecord(value)) throw new Error(`Utility registry entry ${index} is invalid`)
  const id = requiredString(value['id'], `Utility registry entry ${index} ID`)
  assertId(id, `Utility registry entry ${index} ID`)
  if (typeof value['createdAt'] !== 'number' || typeof value['updatedAt'] !== 'number') {
    throw new Error(`Utility registry entry ${index} has invalid timestamps`)
  }
  const normalized = normalizeInput(value)
  return {
    ...normalized,
    id,
    createdAt: value['createdAt'],
    updatedAt: value['updatedAt']
  } as UtilityDefinition
}

function normalizeInput(value: unknown): UtilityDefinitionInput {
  if (!isRecord(value)) throw new TypeError('Utility definition must be an object')
  const kind = value['kind']
  if (typeof kind !== 'string' || !UTILITY_KINDS.has(kind as UtilityKind)) {
    throw new TypeError('Utility kind is invalid')
  }
  const enabled = value['enabled'] === undefined ? true : value['enabled']
  if (typeof enabled !== 'boolean') throw new TypeError('Utility enabled must be a boolean')
  const activation = value['activation'] === undefined ? 'on_demand' : value['activation']
  if (typeof activation !== 'string' || !ACTIVATIONS.has(activation as UtilityActivation)) {
    throw new TypeError('Utility activation is invalid')
  }

  return {
    kind: kind as UtilityKind,
    name: boundedString(value['name'], 'Utility name', 1, 120),
    description: boundedString(value['description'], 'Utility description', 0, 2_000),
    enabled,
    activation: activation as UtilityActivation,
    scope: parseScope(value['scope']),
    config: parseConfig(kind as UtilityKind, value['config']),
    credentials: parseCredentials(value['credentials']),
    harnessBindings: parseBindings(value['harnessBindings'])
  }
}

function parseConfig(kind: UtilityKind, value: unknown): UtilityConfigMap[UtilityKind] {
  if (!isRecord(value)) throw new TypeError('Utility config must be an object')
  rejectInlineSecrets(value)
  switch (kind) {
    case 'mcp': {
      const transport = value['transport']
      if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
        throw new TypeError('MCP transport is invalid')
      }
      const command = optionalString(value['command'], 'MCP command', 500)
      const url = optionalUrl(value['url'], 'MCP URL')
      if (transport === 'stdio' && !command)
        throw new TypeError('stdio MCP utilities require a command')
      if (transport !== 'stdio' && !url)
        throw new TypeError(`${transport} MCP utilities require a URL`)
      return {
        transport,
        ...(command ? { command } : {}),
        ...(value['args'] === undefined
          ? {}
          : { args: stringArray(value['args'], 'MCP arguments') }),
        ...(url ? { url } : {}),
        ...(value['environment'] === undefined
          ? {}
          : { environment: stringRecord(value['environment'], 'MCP environment') }),
        ...(value['headers'] === undefined
          ? {}
          : { headers: stringRecord(value['headers'], 'MCP headers') })
      }
    }
    case 'skill':
      return {
        instructions: boundedString(value['instructions'], 'Skill instructions', 1, 200_000),
        ...(value['supportingFiles'] === undefined
          ? {}
          : { supportingFiles: relativePathArray(value['supportingFiles']) })
      }
    case 'web_search':
    case 'web_fetch':
      return {
        ...(value['provider'] === undefined
          ? {}
          : { provider: parseWebToolProvider(value['provider']) }),
        ...(optionalUrl(value['endpoint'], 'Web utility endpoint')
          ? { endpoint: optionalUrl(value['endpoint'], 'Web utility endpoint') }
          : {}),
        ...(value['headers'] === undefined
          ? {}
          : { headers: stringRecord(value['headers'], 'Web utility headers') })
      }
    case 'computer_use':
      return {
        backend: boundedString(value['backend'], 'Computer-use backend', 1, 120),
        ...(optionalUrl(value['endpoint'], 'Computer-use endpoint')
          ? { endpoint: optionalUrl(value['endpoint'], 'Computer-use endpoint') }
          : {})
      }
    case 'provider':
      return {
        providerId: identifier(value['providerId'], 'Provider ID'),
        ...(optionalUrl(value['endpoint'], 'Provider endpoint')
          ? { endpoint: optionalUrl(value['endpoint'], 'Provider endpoint') }
          : {}),
        ...(optionalString(value['defaultModel'], 'Default model', 256)
          ? { defaultModel: optionalString(value['defaultModel'], 'Default model', 256) }
          : {})
      }
    case 'image_descriptor':
      return {
        harnessId: identifier(value['harnessId'], 'Image descriptor harness ID'),
        providerId: identifier(value['providerId'], 'Image descriptor provider ID'),
        modelId: boundedString(value['modelId'], 'Image descriptor model ID', 1, 256)
      }
  }
}

function parseWebToolProvider(value: unknown): WebToolProviderId {
  if (typeof value !== 'string' || !WEB_TOOL_PROVIDERS.has(value as WebToolProviderId)) {
    throw new TypeError('Web utility provider is invalid')
  }
  return value as WebToolProviderId
}

function parseScope(value: unknown): UtilityScope {
  if (!isRecord(value)) throw new TypeError('Utility scope must be an object')
  if (value['level'] === 'global') return { level: 'global' }
  if (value['level'] === 'project') {
    return { level: 'project', projectId: identifier(value['projectId'], 'Project ID') }
  }
  if (value['level'] === 'thread') {
    return {
      level: 'thread',
      projectId: identifier(value['projectId'], 'Project ID'),
      threadId: identifier(value['threadId'], 'Thread ID')
    }
  }
  throw new TypeError('Utility scope level is invalid')
}

function parseCredentials(value: unknown): UtilityCredentialMetadata[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError('Utility credentials must be an array')
  const ids = new Set<string>()
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`Utility credential ${index} must be an object`)
    const credential: UtilityCredentialMetadata = {
      id: identifier(entry['id'], `Utility credential ${index} ID`),
      label: boundedString(entry['label'], `Utility credential ${index} label`, 1, 120),
      secretRef: identifier(entry['secretRef'], `Utility credential ${index} secret reference`),
      required: entry['required'] === true,
      ...(optionalString(entry['environmentVariable'], 'Credential environment variable', 160)
        ? {
            environmentVariable: optionalString(
              entry['environmentVariable'],
              'Credential environment variable',
              160
            )
          }
        : {})
    }
    if (entry['required'] !== true && entry['required'] !== false) {
      throw new TypeError(`Utility credential ${index} required must be a boolean`)
    }
    if (ids.has(credential.id))
      throw new TypeError(`Duplicate utility credential ID: ${credential.id}`)
    ids.add(credential.id)
    return credential
  })
}

function parseBindings(value: unknown): HarnessUtilityBinding[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError('Harness bindings must be an array')
  const harnesses = new Set<string>()
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`Harness binding ${index} must be an object`)
    const strategy = entry['strategy']
    if (
      typeof strategy !== 'string' ||
      !BINDING_STRATEGIES.has(strategy as HarnessUtilityBinding['strategy'])
    ) {
      throw new TypeError(`Harness binding ${index} strategy is invalid`)
    }
    const binding: HarnessUtilityBinding = {
      harnessId: identifier(entry['harnessId'], `Harness binding ${index} harness ID`),
      strategy: strategy as HarnessUtilityBinding['strategy'],
      ...(optionalString(entry['nativeCapability'], 'Native capability', 120)
        ? { nativeCapability: optionalString(entry['nativeCapability'], 'Native capability', 120) }
        : {}),
      ...(optionalString(entry['transportName'], 'Transport name', 160)
        ? { transportName: optionalString(entry['transportName'], 'Transport name', 160) }
        : {}),
      ...(entry['options'] === undefined
        ? {}
        : {
            options: checkedNonSecretRecord(entry['options'], 'Harness binding options')
          })
    }
    if (harnesses.has(binding.harnessId)) {
      throw new TypeError(`Duplicate harness binding: ${binding.harnessId}`)
    }
    harnesses.add(binding.harnessId)
    return binding
  })
}

function rejectInlineSecrets(value: Record<string, unknown>): void {
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_CONFIG_KEY.test(key)) {
      if (typeof nested === 'string' && /\{env:[A-Za-z_][A-Za-z0-9_]*\}/u.test(nested)) {
        continue
      }
      throw new TypeError(`Utility config field "${key}" must use an opaque credential reference`)
    }
    if (isRecord(nested)) rejectInlineSecrets(nested)
    if (Array.isArray(nested)) {
      for (const entry of nested) {
        if (isRecord(entry)) rejectInlineSecrets(entry)
      }
    }
  }
}

function scopeApplies(scope: UtilityScope, context: UtilityResolutionContext): boolean {
  if (scope.level === 'global') return true
  if (scope.projectId !== context.projectId) return false
  return scope.level === 'project' || scope.threadId === context.threadId
}

function matchesTaskQuery(utility: UtilityDefinition, query: string | undefined): boolean {
  const normalizedQuery = query?.toLocaleLowerCase().replaceAll(/[_-]+/gu, ' ').trim()
  if (!normalizedQuery) return false
  return [utility.name, utility.kind, utility.description]
    .map((value) => value.toLocaleLowerCase().replaceAll(/[_-]+/gu, ' ').trim())
    .filter((value) => value.length >= 3)
    .some((value) => normalizedQuery.includes(value))
}

function scopesEqual(left: UtilityScope, right: UtilityScope): boolean {
  if (left.level !== right.level) return false
  if (left.level === 'global' && right.level === 'global') return true
  if (left.level === 'project' && right.level === 'project') {
    return left.projectId === right.projectId
  }
  if (left.level === 'thread' && right.level === 'thread') {
    return left.projectId === right.projectId && left.threadId === right.threadId
  }
  return false
}

function scopeRank(scope: UtilityScope): number {
  return scope.level === 'thread' ? 2 : scope.level === 'project' ? 1 : 0
}

function normalizeCapability(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '')
}

function assertUpdate(value: UtilityDefinitionPatch): void {
  if (!isRecord(value)) throw new TypeError('Utility update must be an object')
  const allowed = new Set([
    'name',
    'description',
    'enabled',
    'activation',
    'scope',
    'config',
    'credentials',
    'harnessBindings'
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported utility update field: ${key}`)
  }
}

function assertSearchOptions(value: UtilitySearchOptions): void {
  if (!isRecord(value)) throw new TypeError('Utility search options must be an object')
  if (value.query !== undefined) boundedString(value.query, 'Utility search query', 0, 500)
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new TypeError('Utility search enabled filter must be a boolean')
  }
  if (value.kinds !== undefined) {
    if (!Array.isArray(value.kinds) || value.kinds.some((kind) => !UTILITY_KINDS.has(kind))) {
      throw new TypeError('Utility search kinds are invalid')
    }
  }
  if (value.scope !== undefined) parseScope(value.scope)
}

function assertResolutionContext(value: UtilityResolutionContext): void {
  if (!isRecord(value)) throw new TypeError('Utility resolution context must be an object')
  identifier(value.harnessId, 'Harness ID')
  if (value.projectId !== undefined) identifier(value.projectId, 'Project ID')
  if (value.threadId !== undefined) {
    identifier(value.threadId, 'Thread ID')
    if (!value.projectId) throw new TypeError('Thread utility resolution requires a project ID')
  }
  if (
    value.nativeCapabilities !== undefined &&
    (!Array.isArray(value.nativeCapabilities) ||
      value.nativeCapabilities.some((capability) => typeof capability !== 'string'))
  ) {
    throw new TypeError('Native capabilities must be an array of strings')
  }
  if (value.includeOnDemand !== undefined && typeof value.includeOnDemand !== 'boolean') {
    throw new TypeError('includeOnDemand must be a boolean')
  }
}

function relativePathArray(value: unknown): string[] {
  const paths = stringArray(value, 'Skill supporting files')
  for (const path of paths) {
    if (path.startsWith('/') || path.startsWith('\\') || path.split(/[\\/]+/u).includes('..')) {
      throw new TypeError(`Skill supporting file must be a relative config-root path: ${path}`)
    }
  }
  return paths
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${label} must be an array of strings`)
  }
  return value.map((entry) => boundedString(entry, label, 0, 2_000))
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const record = plainRecord(value, label)
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') throw new TypeError(`${label} values must be strings`)
    result[boundedString(key, `${label} key`, 1, 160)] = boundedString(
      entry,
      `${label} value`,
      0,
      4_000
    )
  }
  return result
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  return structuredClone(value)
}

function checkedNonSecretRecord(value: unknown, label: string): Record<string, unknown> {
  const record = plainRecord(value, label)
  rejectInlineSecrets(record)
  return record
}

function optionalUrl(value: unknown, label: string): string | undefined {
  const text = optionalString(value, label, 2_000)
  if (!text) return undefined
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new TypeError(`${label} must be a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${label} must use HTTP or HTTPS`)
  }
  if (
    parsed.username ||
    parsed.password ||
    [...parsed.searchParams.keys()].some((key) => SENSITIVE_CONFIG_KEY.test(key))
  ) {
    throw new TypeError(`${label} must use an opaque credential reference for secrets`)
  }
  return parsed.toString()
}

function identifier(value: unknown, label: string): string {
  const text = boundedString(value, label, 1, 256)
  assertId(text, label)
  return text
}

function assertId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new TypeError(`${label} contains unsupported characters`)
}

function requiredString(value: unknown, label: string): string {
  return boundedString(value, label, 1, 256)
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, 0, maxLength)
}

function boundedString(
  value: unknown,
  label: string,
  minLength: number,
  maxLength: number
): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const normalized = value.trim()
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new TypeError(`${label} must be between ${minLength} and ${maxLength} characters`)
  }
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
