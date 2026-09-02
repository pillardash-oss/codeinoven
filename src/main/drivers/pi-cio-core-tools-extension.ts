/**
 * The single app-owned Pi extension ("cio-core-tools").
 *
 * Pi loads every `--extension` module during process boot, and each load pays
 * transpilation inside the already-expensive cold start. CodeInOven used to
 * materialize four separate extensions (status, usage, utility gateway,
 * core-tools) and pass four `--extension` flags; this module composes all four
 * generated sources into ONE self-contained file loaded through a single
 * `--extension` argument.
 *
 * Composition is mechanical, not a rewrite: each existing generator
 * (`piStatusExtension`, `piUsageExtension`, `piUtilityGatewayExtension`,
 * `piCoreToolsExtension`) stays the source of truth for its behavior. Its
 * generated module is split into imports + body, the body is wrapped in a
 * scoped factory (module-level constants become factory locals, so identical
 * names across extensions cannot collide), `export default function` becomes
 * the factory's `return`, and the merged module's default export invokes all
 * four factories in order. A generator that grows a new import is picked up
 * automatically by the import parser — a source that stops parsing fails
 * materialization loudly instead of silently dropping behavior.
 *
 * Per-session paths are embedded through the same placeholders as before:
 * `__HANDOFF_PATH__` (utility gateway handoff file) and
 * `__CIO_SYSTEM_PROMPT_PATH__` (per-turn system prompt handoff file), both
 * rewritten by the driver at materialization time.
 *
 * The MCP bridge extension (utility-runtime overlay) and the custom-providers
 * extension (disposable model-discovery overlay) are intentionally NOT part of
 * this module — they are conditional overlays, not part of the always-on set.
 */

import { piCoreToolsExtension } from './pi-core-tools-extension'
import { piStatusExtension } from './pi-status-extension'
import { piUsageExtension } from './pi-usage-extension'
import { piUtilityGatewayExtension } from './pi-utility-gateway-extension'

/** One parsed `import` statement of a generated extension module. */
interface GeneratedImport {
  typeOnly: boolean
  module: string
  /** Named import clauses, kept verbatim (aliases included). */
  bindings: string[]
  /** Verbatim statement for import shapes the parser does not model. */
  raw?: string
}

export interface CioCoreToolsExtensionOptions {
  /** Absolute path of the per-session utility-gateway handoff file. */
  gatewayHandoffPath: string
  /** Absolute path of the per-session system-prompt handoff file. */
  systemPromptPath: string
  /** Absolute path of the per-session allowed-tools handoff file. Empty array
   *  (the seed) means every pi built-in tool is available. */
  allowedToolsPath: string
}

/** Split a generated extension module into its import statements and body. */
function splitGeneratedModule(source: string): { imports: GeneratedImport[]; body: string } {
  const lines = source.split('\n')
  const imports: GeneratedImport[] = []
  let index = 0
  while (index < lines.length && (lines[index] ?? '').startsWith('import ')) {
    let statement = lines[index] ?? ''
    while (!/from\s*['"][^'"]+['"];?\s*$/u.test(statement.trimEnd()) && index + 1 < lines.length) {
      index += 1
      statement = `${statement}\n${lines[index] ?? ''}`
    }
    if (!/from\s*['"][^'"]+['"];?\s*$/u.test(statement.trimEnd())) {
      throw new Error(`Generated Pi extension import could not be parsed: ${statement}`)
    }
    const named = statement.match(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/u)
    if (named) {
      imports.push({
        typeOnly: Boolean(named[1]),
        module: named[3] ?? '',
        bindings: (named[2] ?? '')
          .split(',')
          .map((binding) => binding.trim())
          .filter((binding) => binding.length > 0)
      })
    } else {
      imports.push({ typeOnly: false, module: '', bindings: [], raw: statement })
    }
    index += 1
  }
  return { imports, body: lines.slice(index).join('\n') }
}

/** Merge import statements across modules, unioning named bindings per module. */
function mergeGeneratedImports(groups: GeneratedImport[][]): string {
  const merged: GeneratedImport[] = []
  const byKey = new Map<string, GeneratedImport>()
  const rawStatements: string[] = []
  for (const group of groups) {
    for (const entry of group) {
      if (entry.raw !== undefined) {
        rawStatements.push(entry.raw)
        continue
      }
      const key = `${entry.typeOnly ? 'type' : 'value'}:${entry.module}`
      const existing = byKey.get(key)
      if (existing) {
        for (const binding of entry.bindings) {
          if (!existing.bindings.includes(binding)) existing.bindings.push(binding)
        }
        continue
      }
      const copy: GeneratedImport = { ...entry, bindings: [...entry.bindings] }
      byKey.set(key, copy)
      merged.push(copy)
    }
  }
  const statements = merged.map((entry) =>
    entry.typeOnly
      ? `import type { ${entry.bindings.join(', ')} } from '${entry.module}'`
      : `import { ${entry.bindings.join(', ')} } from '${entry.module}'`
  )
  return [...statements, ...rawStatements].join('\n')
}

/**
 * Turn one generated module body into a scoped factory. The body's top-level
 * constants become factory locals (no cross-extension identifier collisions)
 * and its `export default function` — rewritten to a `return` — becomes the
 * factory's result, later invoked with the shared ExtensionAPI.
 */
function scopedExtensionFactory(factoryName: string, body: string): string {
  if (!body.includes('export default function')) {
    throw new Error(`Generated Pi extension body has no default export: ${factoryName}`)
  }
  const rewritten = body.replace('export default function', 'return function')
  return `const ${factoryName} = (): ((pi: ExtensionAPI) => void) => {\n${rewritten}}\n`
}

/** Compose the four app-owned extensions into one self-contained module source. */
export function piCioCoreToolsExtension(options: CioCoreToolsExtensionOptions): string {
  const sources = [
    { factory: '__cioStatusExtension', source: piStatusExtension() },
    { factory: '__cioUsageExtension', source: piUsageExtension() },
    { factory: '__cioGatewayExtension', source: piUtilityGatewayExtension() },
    { factory: '__cioCoreToolsExtension', source: piCoreToolsExtension() }
  ]
  const parsed = sources.map((entry) => {
    const split = splitGeneratedModule(entry.source)
    return { factory: entry.factory, imports: split.imports, body: split.body }
  })
  const header = mergeGeneratedImports(parsed.map((entry) => entry.imports))
  const factories = parsed
    .map((entry) => scopedExtensionFactory(entry.factory, entry.body))
    .join('\n')
  return `${header}

${factories}
export default function codeInOvenCioCoreToolsExtension(pi: ExtensionAPI): void {
  __cioStatusExtension(pi)
  __cioUsageExtension(pi)
  __cioGatewayExtension(pi)
  __cioCoreToolsExtension(pi)
}
`
    .replace('__HANDOFF_PATH__', JSON.stringify(options.gatewayHandoffPath).slice(1, -1))
    .replace('__CIO_SYSTEM_PROMPT_PATH__', JSON.stringify(options.systemPromptPath).slice(1, -1))
    .replace('__CIO_ALLOWED_TOOLS_PATH__', JSON.stringify(options.allowedToolsPath).slice(1, -1))
}
