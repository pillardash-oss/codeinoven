import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'path'
import type {
  BaseUrlProvider,
  HarnessCommand,
  ProviderCatalog,
  ProviderModel
} from '../../../lib/types'
import { PI_THINKING_PRESETS } from '../../../lib/pi-thinking-presets'
import { buildProcessEnvironmentAsync } from '../cli-environment'
import { piNativeProviderIds } from '../../agents/native-provider-config-service'
import type { PiAuthConfigService } from '../../providers/pi-auth-config'
import type { BaseUrlProviderService } from '../../providers/base-url-provider-service'
import { apiKeyEnvVarFor } from '../../providers/base-url-provider-service'
import type { SecretVault } from '../../storage/secret-vault'
import type { StorageEngine } from '../../storage/storage-engine'
import { Logger } from '../../system/logger'
import {
  prepareHarnessInvocation,
  resolveHarnessRuntime,
  runHarnessCommand
} from '../harness-runtime'
import { PiRpcClient } from '../pi-rpc-client'
import { piCustomProvidersExtension } from '../pi-providers-extension'
import type { TitleModelCandidate } from '../persistent-cli-driver'
import { numberValue, record, stringValue } from './pi-values'

const THINKING_PRESETS = PI_THINKING_PRESETS
const PI_CHEAP_MODEL_DISCOVERY_TIMEOUT_MS = 10_000
/** Hard cap on the explicit `pi update --models` catalog refresh. Pi aborts its
 *  own refresh after 15s and reports the failure, so this only bounds a process
 *  that never exits. */
const PI_MODEL_CATALOG_REFRESH_TIMEOUT_MS = 20_000

/** Fallback catalog used when the pi runtime reports no models. */
const PI_FALLBACK_CATALOG: ProviderCatalog[] = [
  {
    id: 'pi',
    name: 'Pi',
    harnessId: 'pi',
    models: [
      {
        id: 'default',
        providerId: 'pi',
        name: 'Default',
        reasoning: true,
        thinkingPresets: THINKING_PRESETS,
        attachment: true,
        toolcall: true
      }
    ]
  }
]

/** Materialized provider-only extension overlay used for model discovery. */
export interface ProviderOverlay {
  args: string[]
  env: Record<string, string>
  cleanup(): Promise<void>
}

/**
 * Everything the catalog needs from the driver: the account it serves (its
 * agent directory owns every credential and provider input), the shared
 * storage boundary, and the two session facts discovery reads.
 */
export interface PiModelCatalogHost {
  readonly id: string
  readonly agentDirectory: string | undefined
  readonly accountEnvironment: NodeJS.ProcessEnv
  readonly baseUrlProviders: BaseUrlProviderService | undefined
  readonly secretVault: SecretVault | undefined
  readonly storage: StorageEngine
  readonly authConfig: PiAuthConfigService
  /** Last project a live session belonged to, for a caller that omits one. */
  lastSessionProject(): string | undefined
  /** Hand the resolved provider key env to the session's next process boot. */
  setProvidersExtensionEnv(sessionId: string, env: Record<string, string>): void
}

/**
 * Pi's model catalog, custom-provider overlay, and command discovery.
 *
 * Every read here is scoped to the account this driver serves; discovery runs
 * in a disposable RPC process so a running turn is never touched.
 */
export class PiModelCatalog {
  constructor(private readonly host: PiModelCatalogHost) {}

  async listProviders(projectPath: string): Promise<ProviderCatalog[]> {
    const connected = await this.connectedProviderIds()
    if (connected !== null && connected.size === 0) return []
    if (!(await resolveHarnessRuntime('pi', projectPath))) {
      return this.filterConnectedCatalogs(structuredClone(PI_FALLBACK_CATALOG), connected)
    }
    try {
      const overlay = await this.buildProviderOverlay(projectPath)
      const models = await this.discoverModels(projectPath, overlay)
      await overlay.cleanup()
      if (models.length === 0) {
        return this.filterConnectedCatalogs(structuredClone(PI_FALLBACK_CATALOG), connected)
      }
      const byProvider = new Map<string, ProviderModel[]>()
      for (const model of models) {
        const providerId = stringValue(model['provider'])
        const modelId = stringValue(model['id'])
        if (!providerId || !modelId) continue
        const reasoning = model['reasoning'] === true
        const list = byProvider.get(providerId) ?? []
        list.push({
          id: modelId,
          providerId,
          name: stringValue(model['name']) ?? modelId,
          reasoning,
          ...(reasoning ? { thinkingPresets: THINKING_PRESETS } : {}),
          attachment: Array.isArray(model['input']) ? model['input'].includes('image') : true,
          toolcall: true,
          ...(numberValue(model['contextWindow'])
            ? { contextWindow: numberValue(model['contextWindow']) }
            : {}),
          // Pi's model record names the response limit `maxTokens`; surfacing it
          // lets the app reserve the model's real completion budget instead of
          // its small default when it composes a turn.
          ...(numberValue(model['maxTokens'])
            ? { maxOutputTokens: numberValue(model['maxTokens']) }
            : {})
        })
        byProvider.set(providerId, list)
      }
      const catalogs = [...byProvider.entries()].map(([id, models]) => ({
        id,
        name: id,
        harnessId: 'pi',
        models
      }))
      return this.filterConnectedCatalogs(
        catalogs.length > 0 ? catalogs : structuredClone(PI_FALLBACK_CATALOG),
        connected
      )
    } catch (error) {
      Logger.dev('Pi provider discovery failed, using fallback catalog', error)
      return this.filterConnectedCatalogs(structuredClone(PI_FALLBACK_CATALOG), connected)
    }
  }

  /** Every connected Pi model whose display name or id identifies it as free. */
  async cheapCandidateModels(projectPath: string): Promise<TitleModelCandidate[]> {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const catalogs = await Promise.race([
      this.listProviders(projectPath).catch(() => []),
      new Promise<ProviderCatalog[]>((resolve) => {
        timeout = setTimeout(() => resolve([]), PI_CHEAP_MODEL_DISCOVERY_TIMEOUT_MS)
      })
    ]).finally(() => {
      if (timeout) clearTimeout(timeout)
    })
    const candidates = new Map<string, TitleModelCandidate>()
    for (const catalog of catalogs) {
      for (const model of catalog.models) {
        if (!/free/iu.test(model.id) && !/free/iu.test(model.name)) continue
        candidates.set(`${model.providerId}/${model.id}`, {
          providerId: model.providerId,
          modelId: model.id
        })
      }
    }
    return [...candidates.values()]
  }

  /**
   * The providers the user is actually connected to, keyed by the same provider
   * ids pi's catalog reports: credentials in this account's `auth.json` (written
   * by pi's TUI or CodeInOven's connect flow), providers configured in its
   * `models.json` (keyed catalog providers and keyless local servers alike), and
   * CodeInOven-managed base-URL providers injected through the discovery
   * overlay. Returns `null` when the connected set cannot be determined
   * reliably   callers then keep the catalog unfiltered rather than wrongly
   * hiding every provider behind a transient read failure.
   *
   * Every read here is scoped to the account this driver serves. Reading the
   * harness-global files instead hides the whole catalog of a container-backed
   * account: its credentials never appear in `~/.pi/agent/auth.json`, so the
   * filter would drop every provider the container's pi process just reported
   * and leave only the harness-global custom providers.
   */
  private async connectedProviderIds(): Promise<Set<string> | null> {
    const overlay = this.host.baseUrlProviders
      ? await this.host.baseUrlProviders
          .listEnabled(this.host.id, this.host.agentDirectory)
          .catch(() => null)
      : []
    const nativeIds = await piNativeProviderIds(
      this.host.agentDirectory ? join(this.host.agentDirectory, 'models.json') : undefined
    ).catch(() => null)
    if (overlay === null || nativeIds === null) return null
    const connected = new Set<string>([
      ...(await this.host.authConfig.credentialIds()),
      ...nativeIds
    ])
    for (const provider of overlay) connected.add(provider.id)
    return connected
  }

  private filterConnectedCatalogs(
    catalogs: ProviderCatalog[],
    connected: Set<string> | null
  ): ProviderCatalog[] {
    if (connected === null) return catalogs
    return catalogs.filter((catalog) => connected.has(catalog.id))
  }

  /** Cheap staleness signature of the connected-provider set; see the interface contract. */
  async providerCatalogFingerprint(): Promise<string | null> {
    const connected = await this.connectedProviderIds()
    if (connected === null) return null
    const overlay = this.host.baseUrlProviders
      ? await this.host.baseUrlProviders.listEnabled(this.host.id).catch(() => [])
      : []
    const overlayModels = overlay
      .map((provider) => `${provider.id}=${provider.models.map((model) => model.id).join(',')}`)
      .sort()
      .join('|')
    return JSON.stringify([[...connected].sort(), overlayModels])
  }

  /**
   * Force Pi's own model catalog to re-fetch from upstream (`pi update
   * --models`) against THIS account's agent directory, so the discovery that
   * follows reads catalogs that are fresh at the source instead of the store
   * Pi already has. Pi throttles remote catalogs to once per provider every
   * four hours unless the refresh is forced, which is exactly what the model
   * picker's refresh button has to bypass.
   *
   * The CLI entry point is required here: the bundled RPC entry point
   * hard-codes `--mode rpc` ahead of the arguments, and Pi's own parser then
   * rejects the package command. Pi reports a non-zero exit when any provider
   * fails, so a failed pass leaves the stored catalog untouched   the caller
   * still gets whatever the store holds.
   */
  async refreshModelCatalog(): Promise<void> {
    await runHarnessCommand('pi', ['update', '--models'], {
      env: await buildProcessEnvironmentAsync({
        ...process.env,
        ...this.host.accountEnvironment
      }),
      timeoutMs: PI_MODEL_CATALOG_REFRESH_TIMEOUT_MS,
      bundledEntry: 'cli'
    })
  }

  private async discoverModels(
    projectPath: string,
    overlay: ProviderOverlay
  ): Promise<Array<Record<string, unknown>>> {
    let models: unknown
    const invocation = await prepareHarnessInvocation('pi', ['--mode', 'rpc', ...overlay.args], {
      prepareWindowsTools: false,
      cwd: projectPath,
      env: {
        ...(await buildProcessEnvironmentAsync({
          ...process.env,
          ...this.host.accountEnvironment
        })),
        ...overlay.env,
        ...(await this.workspaceTemporaryEnvironment(projectPath))
      }
    })
    const client = new PiRpcClient({
      invocation
    })
    try {
      await client.newSession()
      models = await client.getAvailableModels()
    } finally {
      client.dispose()
    }
    const payload = record(models)
    const list = Array.isArray(payload?.['models']) ? (payload['models'] as unknown[]) : []
    return list.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    )
  }

  async listCommands(projectPath?: string): Promise<HarnessCommand[]> {
    // Commands are project-scoped in pi; probe them in a disposable session so
    // the running turn is untouched. Fall back to the last seen project when the
    // caller omits the path (the base class declares a no-arg signature).
    const cwd = projectPath ?? this.host.lastSessionProject() ?? process.cwd()
    if (!(await resolveHarnessRuntime('pi', cwd))) return []
    const invocation = await prepareHarnessInvocation('pi', ['--mode', 'rpc'], {
      prepareWindowsTools: false,
      cwd,
      env: {
        ...(await buildProcessEnvironmentAsync({
          ...process.env,
          ...this.host.accountEnvironment
        })),
        ...(await this.workspaceTemporaryEnvironment(cwd))
      }
    })
    const client = new PiRpcClient({
      invocation
    })
    try {
      await client.newSession()
      const payload = record(await client.getCommands())
      const commands = Array.isArray(payload?.['commands']) ? payload['commands'] : []
      const result: HarnessCommand[] = []
      for (const raw of commands) {
        const command = record(raw)
        const name = stringValue(command?.['name'])
        if (!name) continue
        const source = stringValue(command?.['source'])
        const description = stringValue(command?.['description'])
        result.push({
          name,
          ...(description ? { description } : {}),
          ...(source === 'skill' ? { source: 'skill' as const } : {})
        })
      }
      return result
    } catch (error) {
      Logger.dev('Pi command discovery failed:', error)
      return []
    } finally {
      client.dispose()
    }
  }

  /** Node uses TEMP/TMP on Windows and TMPDIR on Unix. The runtime boundary
   * translates TMPDIR for WSL and forwards it into the Linux process. Keep
   * output files available across turns under the scope's working directory.
   */
  async workspaceTemporaryEnvironment(
    projectPath: string
  ): Promise<{ TMPDIR: string; TEMP: string; TMP: string }> {
    const directory = join(projectPath, '.cio', 'tmp', 'pi')
    await mkdir(directory, { recursive: true })
    return { TMPDIR: directory, TEMP: directory, TMP: directory }
  }

  private async buildProviderOverlay(projectPath: string): Promise<ProviderOverlay> {
    const args: string[] = []
    const env: Record<string, string> = {}
    let directory: string | null = null
    const resolved = await this.resolveOverlayProviders()
    if (resolved) {
      const temporaryEnvironment = await this.workspaceTemporaryEnvironment(projectPath)
      directory = await mkdtemp(join(temporaryEnvironment['TMPDIR'], 'providers-'))
      const extensionPath = join(directory, 'codeinoven-providers.ts')
      await writeFile(extensionPath, piCustomProvidersExtension(resolved.providers), 'utf8')
      args.push('--extension', extensionPath)
      Object.assign(env, resolved.env)
    }
    return {
      args,
      env,
      cleanup: async () => {
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  /**
   * Enabled custom providers for this driver plus the env carrying their keys.
   * Managed account containers run pi against their own agent dir, which has
   * no models.json; harness-global custom providers (keyless local servers
   * like llama.cpp) are mirrored in so their models stay selectable.
   */
  private async resolveOverlayProviders(): Promise<{
    providers: BaseUrlProvider[]
    env: Record<string, string>
  } | null> {
    const containerAgentDir =
      this.host.accountEnvironment['PI_CODING_AGENT_DIR']?.trim() || undefined
    const providers = this.host.baseUrlProviders
      ? await this.host.baseUrlProviders
          .listEnabled(this.host.id, containerAgentDir)
          .catch(() => [])
      : []
    if (providers.length === 0 || !this.host.secretVault) return null
    const env: Record<string, string> = {}
    for (const provider of providers) {
      if (provider.apiKeyRef && provider.apiKeyEnvVar) {
        env[provider.apiKeyEnvVar] = await this.host.secretVault.resolve(provider.apiKeyRef)
        continue
      }
      // Native providers mirrored from the global models.json have no vault
      // reference; their key (when configured) rides the env var instead.
      if (
        !provider.apiKeyEnvVar &&
        provider.harnessId === this.host.id &&
        this.host.baseUrlProviders
      ) {
        const nativeKey = await this.host.baseUrlProviders
          .readNativeApiKey(this.host.id, provider.id)
          .catch(() => undefined)
        if (nativeKey) {
          const envVar = apiKeyEnvVarFor(provider.id)
          env[envVar] = nativeKey
          provider.apiKeyEnvVar = envVar
        }
      }
    }
    return { providers, env }
  }

  /**
   * Materialize the per-session custom-providers extension next to the
   * cio-core-tools module so the long-lived RPC process registers the same
   * custom providers discovery showed (managed containers cannot see the
   * harness-global models.json on their own). Rewritten on every process boot,
   * so provider edits reach the next fresh session.
   */
  async materializeProvidersExtension(sessionId: string): Promise<string | null> {
    try {
      const resolved = await this.resolveOverlayProviders()
      if (!resolved) return null
      const extensionRelative = join('runtime', 'cio-providers', sessionId, 'providers.ts')
      await this.host.storage.writeRaw(
        extensionRelative,
        piCustomProvidersExtension(resolved.providers)
      )
      this.host.setProvidersExtensionEnv(sessionId, resolved.env)
      return this.host.storage.resolve(extensionRelative)
    } catch (error) {
      Logger.dev('Pi providers extension materialization failed:', error)
      return null
    }
  }
}
