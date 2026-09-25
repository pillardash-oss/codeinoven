import { spawn } from 'child_process'
import type { ModelInfo, SDKUserMessage, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type { ProviderModel, ThinkingPreset } from '../../../lib/types'
import { buildWslProcessEnvironment, resolveHarnessRuntime } from '../harness-runtime'
import { buildClaudeEnvironment } from './claude-environment'
import { record, string } from './claude-values'

/** Claude Code model discovery, catalog mapping, and thinking presets. */

export const THINKING_PRESETS: ThinkingPreset[] = [
  { id: 'low', label: 'Low', description: 'Low reasoning effort' },
  { id: 'medium', label: 'Medium', description: 'Moderate reasoning effort' },
  { id: 'high', label: 'High', description: 'High reasoning effort' },
  {
    id: 'xhigh',
    label: 'Extra high',
    description: 'Extra-high effort; uses significantly more quota'
  },
  {
    id: 'max',
    label: 'Max · high usage',
    description: 'Maximum effort; uses significantly more quota'
  }
]

export const CLAUDE_MODEL_DISCOVERY_TIMEOUT_MS = 15_000

export function fallbackClaudeModel(): ProviderModel {
  return {
    id: 'default',
    providerId: 'anthropic',
    name: 'Default (recommended)',
    reasoning: true,
    thinkingPresets: THINKING_PRESETS,
    attachment: true,
    toolcall: true,
    fastSupported: false
  }
}

export function claudeAuthenticationResult(value: unknown): boolean | undefined {
  const entry = record(value)
  const type = string(entry?.['type'])
  if (type === 'assistant') {
    return entry?.['error'] === 'authentication_failed' ||
      entry?.['error'] === 'oauth_org_not_allowed'
      ? false
      : true
  }
  if (type !== 'stream_event') return undefined
  return string(record(entry?.['event'])?.['type']) === 'message_start' ? true : undefined
}

export function claudeModelName(model: ModelInfo): string {
  const resolvedName = model.description.split(' · ', 1)[0]?.trim()
  if (!resolvedName) return model.displayName
  if (model.value === 'default') return model.displayName
  return model.resolvedModel && model.resolvedModel !== model.value
    ? `${resolvedName} (latest)`
    : resolvedName
}

export function mapClaudeModel(model: ModelInfo): ProviderModel {
  const supportedEffortLevels = new Set<string>(model.supportedEffortLevels ?? [])
  const thinkingPresets = THINKING_PRESETS.filter((preset) => supportedEffortLevels.has(preset.id))
  const reasoning = model.supportsEffort === true || model.supportsAdaptiveThinking === true
  return {
    id: model.value,
    providerId: 'anthropic',
    name: claudeModelName(model),
    reasoning,
    thinkingPresets: reasoning ? thinkingPresets : undefined,
    attachment: true,
    toolcall: true,
    fastSupported: model.supportsFastMode ?? false
  }
}

export function keepClaudeDiscoveryOpen(): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<SDKUserMessage>>(() => undefined)
      }
    }
  }
}

export async function discoverClaudeModels(
  projectPath: string,
  accountEnvironment: NodeJS.ProcessEnv = {}
): Promise<ProviderModel[]> {
  const runtime = await resolveHarnessRuntime('claude', projectPath)
  if (!runtime) throw new Error('Claude Code CLI is unavailable')
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const wslDistribution = runtime.target.kind === 'wsl' ? runtime.target.distribution : undefined
  const spawnClaudeCodeProcess = wslDistribution
    ? (options: SpawnOptions) =>
        spawn(
          runtime.executable,
          ['--distribution', wslDistribution, '--', runtime.resolvedPath, ...options.args],
          {
            ...(options.cwd ? { cwd: options.cwd } : {}),
            env: buildWslProcessEnvironment(options.env),
            signal: options.signal,
            stdio: ['pipe', 'pipe', 'ignore']
          }
        )
    : undefined
  const handle = query({
    prompt: keepClaudeDiscoveryOpen(),
    options: {
      cwd: projectPath,
      env: buildClaudeEnvironment(accountEnvironment),
      pathToClaudeCodeExecutable: runtime.resolvedPath,
      ...(spawnClaudeCodeProcess ? { spawnClaudeCodeProcess } : {}),
      tools: []
    }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const models = await Promise.race([
      handle.supportedModels(),
      new Promise<ModelInfo[]>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Claude Code model discovery timed out')),
          CLAUDE_MODEL_DISCOVERY_TIMEOUT_MS
        )
      })
    ])
    return models.map(mapClaudeModel)
  } finally {
    if (timer) clearTimeout(timer)
    handle.close()
  }
}
