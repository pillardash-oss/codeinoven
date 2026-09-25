import type { ProviderCatalog, ProviderModel, ThinkingPreset } from '../../../lib/types'
import type { SendPromptOptions } from '../driver.interface'
import { numberValue, recordValue, stringValue } from './opencode-values'

export const STANDARD_THINKING_VARIANTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max · high usage' },
  { id: 'ultra', label: 'Ultra · highest usage' }
]

/**
 * Map a thread's permission level onto opencode's per-session permission rules.
 * opencode turns a prompt's `tools` field into session permission rules
 * (`{permission, action: "allow"|"deny", pattern: "*"}`), so a blanket
 * `{"*": false}` becomes a hard deny-all that also blocks `external_directory`
 * reads (e.g. `/tmp/...`) before the engine's `permission.asked` auto-replies
 * can approve them. Mirror the permission modes of the other drivers:
 *
 *  - `full_access` → dangerously skip: `{"*": true}` allows every tool and
 *    permission, so nothing is ever asked or denied.
 *  - `auto_review` → auto-approve: the app's tool allow-list stays a hard deny
 *    for non-listed tools, but `external_directory` is allowed outright so
 *    external reads are auto-approved instead of hard-denied.
 *
 * Returns `undefined` when the prompt should not constrain tools at all.
 */
export function opencodePermissionTools(
  opts: Pick<SendPromptOptions, 'settings' | 'allowedTools'>
): Record<string, boolean> | undefined {
  if (opts.settings.permissionLevel === 'full_access') {
    return { '*': true }
  }
  const tools: Record<string, boolean> = {}
  if (opts.allowedTools !== undefined) {
    tools['*'] = false
    for (const tool of opts.allowedTools) tools[tool] = true
  }
  tools['external_directory'] = true
  return tools
}

/** Parse `opencode models --verbose`: model ref line followed by one JSON object. */
export function parseOpenCodeModels(output: string): Array<Record<string, unknown>> {
  const models: Array<Record<string, unknown>> = []
  const lines = output.split(/\r?\n/u)
  let index = 0
  while (index < lines.length) {
    const reference = lines[index]?.trim() ?? ''
    index += 1
    if (!reference || reference.startsWith('{')) continue
    while (index < lines.length && !lines[index]?.trim().startsWith('{')) index += 1
    if (index >= lines.length) break
    let depth = 0
    let json = ''
    do {
      const line = lines[index] ?? ''
      json += `${line}\n`
      for (const character of line) {
        if (character === '{') depth += 1
        else if (character === '}') depth -= 1
      }
      index += 1
    } while (index < lines.length && depth > 0)
    try {
      const parsed = JSON.parse(json) as unknown
      const model = recordValue(parsed)
      if (!model) continue
      const [providerId, ...modelIdParts] = reference.split('/')
      const modelId = stringValue(model['id']) ?? modelIdParts.join('/')
      const resolvedProviderId = stringValue(model['providerID']) ?? providerId
      if (!resolvedProviderId || !modelId) continue
      models.push({ ...model, id: modelId, providerID: resolvedProviderId })
    } catch {
      // Ignore one malformed entry; remaining CLI entries can still populate picker.
    }
  }
  return models
}

export function modelThinkingPresets(m: Record<string, unknown>): ThinkingPreset[] | undefined {
  const variants = recordValue(m['variants']) as Record<string, unknown> | undefined
  if (!variants) return undefined
  return Object.keys(variants).map((id) => ({
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
    description: `${id} reasoning effort`
  }))
}

export function mapOpenCodeProvider(raw: Record<string, unknown>): ProviderCatalog | null {
  const id = raw['id'] as string | undefined
  if (!id) return null
  const modelsById = (raw['models'] as Record<string, Record<string, unknown>> | undefined) ?? {}
  const models: ProviderModel[] = Object.values(modelsById)
    .map((m) => {
      const capabilities = (m['capabilities'] as Record<string, boolean> | undefined) ?? {}
      const limit = recordValue(m['limit'])
      const reasoning = capabilities['reasoning'] === true
      const modelId = (m['id'] as string | undefined) ?? ''
      return {
        id: modelId,
        providerId: id,
        name: (m['name'] as string | undefined) ?? modelId,
        reasoning,
        thinkingPresets: modelThinkingPresets(m),
        // opencode reports `capabilities.attachment` (false for text-only
        // models). Unknown state stays vision-capable so models are never
        // hidden incorrectly.
        attachment: capabilities['attachment'] !== false,
        toolcall: capabilities['toolcall'] === true,
        contextWindow: numberValue(limit?.['context']),
        fastSupported: Boolean(modelId && modelsById[`${modelId}-fast`])
      }
    })
    .filter((m) => m.id)
  return { id, name: (raw['name'] as string | undefined) ?? id, harnessId: 'opencode', models }
}
