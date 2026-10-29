import type { ProviderCatalog, ProviderModel } from '../../../lib/types'
import { Logger } from '../../system/logger'
import { buildProcessEnvironmentAsync } from '../cli-environment'
import { runHarnessCommand } from '../harness-runtime'
import { fallbackCodexModels, THINKING_PRESETS } from '../codex/codex-models'
import {
  type CodexWindowCatalog,
  emptyCodexWindowCatalog,
  parseCodexWindowCatalog
} from '../codex/codex-catalog'
import { tomlString, tomlStringMap } from '../codex/codex-tools'
import { CODEX_WINDOW_CATALOG_TTL_MS } from '../codex-driver'
import type { CodexDriver } from '../codex-driver'

/** CodexDriver catalog: one concern, moved verbatim from the composition root. */
export class CodexDriverCatalog {
  constructor(
    private readonly host: CodexDriver,
    private readonly base: CodexDriver['base']
  ) {}

  async listProviders(projectPath: string): Promise<ProviderCatalog[]> {
    // Codex states its own context windows in its model catalog, so the picker
    // offers exactly what Codex accepts and starts at what Codex uses.
    const windows = await this.codexWindowCatalog(projectPath)
    let builtInModels: ProviderModel[]
    try {
      const discovered = await this.host.units['capabilities'].discoverModels(projectPath)
      builtInModels = discovered.length > 0 ? discovered : fallbackCodexModels(windows)
    } catch (error) {
      Logger.info('Codex model discovery fell back to the bundled catalog', {
        error: error instanceof Error ? error.message : String(error)
      })
      builtInModels = fallbackCodexModels(windows)
    }
    const catalogs: ProviderCatalog[] = [
      {
        id: 'openai',
        name: 'OpenAI',
        harnessId: 'codex',
        models: builtInModels
      }
    ]
    if (!this.host.baseUrlProviders) return catalogs
    const customProviders = await this.host.baseUrlProviders.listEnabled(this.host.base.id)
    for (const custom of customProviders) {
      catalogs.push({
        id: custom.id,
        name: custom.name,
        harnessId: 'codex',
        models: custom.models.map((model) => ({
          id: `${custom.id}/${model.id}`,
          providerId: custom.id,
          name: model.name || model.id,
          reasoning: model.reasoning,
          thinkingPresets: model.reasoning ? THINKING_PRESETS : undefined,
          attachment: model.vision !== false,
          toolcall: true,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {})
        }))
      })
    }
    return catalogs
  }

  /**
   * Codex's own context windows for every model it lists, read through
   * `codex debug models`, the CLI's supported dump of the catalog it actually
   * runs with. A failed read yields an empty catalog rather than a guessed
   * figure: a model with no stated window shows no window options at all.
   */
  async codexWindowCatalog(projectPath: string, force = false): Promise<CodexWindowCatalog> {
    const home = this.host.codexHomeKey()
    const cached = this.host.codexWindowsByHome.get(home)
    if (!force && cached && Date.now() - cached.readAt < CODEX_WINDOW_CATALOG_TTL_MS)
      return cached.catalog
    const pending = this.host.codexWindowReads.get(home)
    if (pending) return pending
    const read = this.readCodexWindowCatalog(projectPath)
      .then((catalog) => {
        this.host.codexWindowsByHome.set(home, { catalog, readAt: Date.now() })
        return catalog
      })
      .catch((error: unknown) => {
        // A transient failure must not cache an empty catalog: the next
        // discovery reads Codex again instead of showing no windows for minutes.
        Logger.info('Codex context window catalog unavailable', {
          error: error instanceof Error ? error.message : String(error)
        })
        return emptyCodexWindowCatalog()
      })
      .finally(() => {
        this.host.codexWindowReads.delete(home)
      })
    this.host.codexWindowReads.set(home, read)
    return read
  }

  async readCodexWindowCatalog(projectPath: string): Promise<CodexWindowCatalog> {
    const result = await runHarnessCommand('codex', ['debug', 'models'], {
      cwd: projectPath,
      env: await buildProcessEnvironmentAsync({ ...process.env, ...this.host.accountEnvironment }),
      timeoutMs: 20_000,
      // The catalog embeds each model's prompt templates, so it is far larger
      // than any other harness command output.
      maxOutputBytes: 8 * 1024 * 1024
    })
    return parseCodexWindowCatalog(JSON.parse(result.stdout))
  }

  /**
   * Inject every enabled custom base-URL provider as a Codex `model_providers.<id>`
   * override plus its vaulted API key env var. Models are selected as `<id>/<model>`.
   */
  async customProviderOverlay(): Promise<{ env: Record<string, string>; args: string[] }> {
    const env: Record<string, string> = {}
    const args: string[] = []
    if (!this.host.baseUrlProviders || !this.host.secretVault) return { env, args }
    const customProviders = await this.host.baseUrlProviders.listEnabled(this.host.base.id)
    for (const custom of customProviders) {
      const wireApi = custom.npm === '@ai-sdk/openai' ? 'responses' : 'chat'
      args.push('-c', `model_providers.${custom.id}.name=${tomlString(custom.name)}`)
      args.push('-c', `model_providers.${custom.id}.base_url=${tomlString(custom.baseURL)}`)
      args.push('-c', `model_providers.${custom.id}.wire_api=${tomlString(wireApi)}`)
      if (custom.apiKeyRef && custom.apiKeyEnvVar) {
        const apiKey = await this.host.secretVault.resolve(custom.apiKeyRef)
        env[custom.apiKeyEnvVar] = apiKey
        args.push('-c', `model_providers.${custom.id}.env_key=${tomlString(custom.apiKeyEnvVar)}`)
      }
      if (custom.headers && Object.keys(custom.headers).length > 0) {
        args.push(
          '-c',
          `model_providers.${custom.id}.http_headers=${tomlStringMap(custom.headers)}`
        )
      }
    }
    return { env, args }
  }
}
