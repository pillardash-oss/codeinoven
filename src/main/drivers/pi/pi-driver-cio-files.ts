import { join } from 'path'
import type { UtilityGatewayEndpoint } from '../../../lib/gateway-timeout'
import { WORKER_AGENT_BEHAVIOR_PROMPT } from '../../../lib/agent-behavior'
import { BUNDLED_PI_FILE_POLICY } from '../../../lib/bundled-pi-file-protection'
import { AGENT_SECRET_ROOT } from '../../../lib/secret-request'
import type { CompactionFallbackContext, HandoffWorkerSession } from '../driver.interface'
import { piCioCoreToolsExtension } from '../pi-cio-core-tools-extension'
import { Logger } from '../../system/logger'
import { emptyStopRequest } from './pi-values'

/**
 * Storage-relative directory holding one session's app-owned extension runtime
 * files: the composed module, its per-turn handoffs, and the per-session flag
 * files (oversized recovery, stop request, watched sub-agents, and the plan and
 * progress snapshot a rebuilt checkpoint reads). Derived from the session id so
 * a file can be published before the module is materialized.
 */
export function cioCoreToolsDirectory(sessionId: string): string {
  return join('runtime', 'cio-core-tools', sessionId)
}

/** The file surface a pi session's handoff files need. */
export interface PiHandoffStorage {
  resolve(relativePath: string): string
  readRaw(relativePath: string): Promise<string | null>
  writeRaw(relativePath: string, content: string): Promise<void>
  remove(relativePath: string): Promise<void>
}

/**
 * Handoff files plus the app setting the materialized module embeds.
 *
 * The setting is this device's own (the user's question cap); only the files can
 * live on an Oven, so a remote session composes this from an Oven-backed file
 * store and the local configuration. `StorageEngine` satisfies both halves.
 */
export interface PiCioFilesStorage extends PiHandoffStorage {
  getConfig(): Promise<{ agentQuestionCap: number }>
}

/** Everything the per-session runtime files need from the driver. */
export interface PiCioFilesHost {
  /** The file surface for one session's handoff files. */
  storageFor(sessionId: string): PiCioFilesStorage
  /** Whether the session is an auxiliary one-shot (title, summary, lessons). */
  isTitleSession(sessionId: string): boolean
  /** Register the materialized sub-agent watch file for the session. */
  registerWatchPath(sessionId: string, watchFlagPath: string): void
}

/**
 * Which file surface each session's handoff files land on.
 *
 * One driver instance serves many threads, and a thread whose machine is an
 * Oven publishes its handoff files there while a local thread keeps the app's
 * own engine. The choice is per session, never per driver, so a session that
 * was never routed (or whose route was dropped) always reads and writes the
 * local engine exactly as before.
 */
export class PiCioSessionStorages {
  private readonly remotes = new Map<string, PiCioFilesStorage>()

  constructor(private readonly local: PiCioFilesStorage) {}

  /** The file surface for one session's handoff files. */
  storageFor(sessionId: string): PiCioFilesStorage {
    return this.remotes.get(sessionId) ?? this.local
  }

  /** Route one session's handoff files to a remote machine; `null` restores local. */
  set(sessionId: string, storage: PiCioFilesStorage | null): void {
    if (storage) this.remotes.set(sessionId, storage)
    else this.remotes.delete(sessionId)
  }

  /** Drop one session's route so a reused session id never inherits a stale machine. */
  forget(sessionId: string): void {
    this.remotes.delete(sessionId)
  }

  /** Drop every route (driver disposal). */
  clear(): void {
    this.remotes.clear()
  }
}

/**
 * The app-owned runtime files a pi session reads: the composed cio-core-tools
 * extension, its per-turn handoffs (system prompt, history recap, allowed
 * tools, gateway endpoint, oversized-recovery and stop flags), and the custom
 * providers extension's resolved key environment.
 *
 * Every publish is best-effort and path-guarded: a missing materialized path
 * (extension failed to load) never fails a turn.
 */
export class PiCioRuntimeFiles {
  /** Session-keyed turn handoff files carrying the gateway endpoint for the extension, storage-relative. */
  private readonly gatewayHandoffPaths = new Map<string, string>()
  /**
   * Session-keyed endpoints published before the gateway extension was materialized.
   * On the first turn of a fresh session, publishUtilityGatewayEndpoint runs before
   * sendPrompt spawns Pi and materializes the handoff file, so the endpoint must be
   * held here and flushed by materializeCioCoreToolsExtension   otherwise every first
   * cio_util_* call fails with `new URL(route, '')` → "Invalid URL".
   */
  private readonly pendingGatewayEndpoints = new Map<string, UtilityGatewayEndpoint>()
  private readonly cioSystemPromptPaths = new Map<string, string>()
  private readonly cioHistoryRecapPaths = new Map<string, string>()
  private readonly cioAllowedToolsPaths = new Map<string, string>()
  private readonly cioOversizedFlagPaths = new Map<string, string>()
  /** Storage-relative stop-flag files the user's Stop writes for the core-tools
   *  extension. `abort()` publishes a token here before it aborts the root run,
   *  because the extension is the only code that can stop the nested worker
   *  sessions pi keeps inside its own process. */
  private readonly cioStopFlagPaths = new Map<string, string>()
  /** Monotonic per-process counter making every stop token unique. */
  private stopRequestSeq = 0
  private readonly cioCoreToolsExtensionPaths = new Map<string, string>()
  /** Resolved key env for the session's custom-providers extension, merged
   *  into the RPC process environment on every (re)boot. */
  private readonly cioProvidersExtensionEnvs = new Map<string, Record<string, string>>()

  constructor(private readonly host: PiCioFilesHost) {}

  /**
   * Materialize the single app-owned "cio-core-tools" extension for a session  
   * status, usage, the utility gateway, and the core tools composed into one
   * self-contained module (see pi-cio-core-tools-extension.ts) so pi's boot
   * loads one extension instead of four. The gateway handoff file and the
   * per-turn system-prompt handoff file live beside the module; their
   * storage-relative paths feed the existing publish/remove flows unchanged.
   * Startup rejects a failed materialization: running without this module
   * would silently restore Pi's default compaction policy.
   */
  async materializeCoreToolsExtension(
    sessionId: string,
    bundledRuntime: boolean,
    sessionCwd: string
  ): Promise<string | null> {
    // Rebuild on process startup. A restarted session can switch between the
    // bundled and external executables, so a cached module cannot decide scope.
    const existing = this.cioCoreToolsExtensionPaths.get(sessionId)
    try {
      const storage = this.host.storageFor(sessionId)
      const questionCap = (await storage.getConfig()).agentQuestionCap
      const directory = cioCoreToolsDirectory(sessionId)
      // The materialization writes the empty seed when the module is new, so the
      // root it used says whether this session's files belong to this machine or
      // to the Oven that runs it.
      Logger.dev('Pi core-tools extension materialized', {
        sessionId,
        seeding: !existing,
        root: storage.resolve(directory)
      })
      const handoffRelative = join(directory, 'gateway-handoff.json')
      const systemPromptRelative = join(directory, 'system-prompt.txt')
      const historyRecapRelative = join(directory, 'history-recap.txt')
      const allowedToolsRelative = join(directory, 'allowed-tools.json')
      const oversizedFlagRelative = join(directory, 'oversized-recovery.json')
      const stopFlagRelative = join(directory, 'stop-request.json')
      const handoffWorkersRelative = join(directory, 'handoff-workers.json')
      const liveSubagentsRelative = join(directory, 'live-subagents.json')
      // Never seeded: the adopting instance publishes the roster before this
      // module exists, and a seed written here would erase the workers the move
      // carried over. A missing file simply reads as an empty roster.
      const watchFlagRelative = join(directory, 'watched-subagents.json')
      const compactionContextRelative = join(directory, 'compaction-context.json')
      const extensionRelative = join(directory, 'cio-core-tools.ts')
      // Empty endpoint values: the gateway tools surface a clear gateway-inactive
      // error until the first direct-gateway turn publishes the real { url, token }.
      if (!existing) {
        await storage.writeRaw(handoffRelative, JSON.stringify({ url: '', token: '' }))
        await storage.writeRaw(systemPromptRelative, '')
        await storage.writeRaw(historyRecapRelative, '')
        await storage.writeRaw(allowedToolsRelative, '[]')
        await storage.writeRaw(oversizedFlagRelative, JSON.stringify({ armed: false }))
        // A session that moved between instances shares this directory with the
        // process that just released it. Seeding would erase a transfer's own
        // stop request and the live worker roster before the adopting instance
        // reads them, so a file that already exists is left exactly as it is.
        await this.seedIfMissing(sessionId, stopFlagRelative, JSON.stringify(emptyStopRequest()))
        await this.seedIfMissing(
          sessionId,
          watchFlagRelative,
          JSON.stringify({ childSessionIds: [] })
        )
      }
      await storage.writeRaw(
        extensionRelative,
        piCioCoreToolsExtension({
          // One-shot sessions (title, summary, lessons) are pure text turns:
          // they never publish a gateway endpoint, so the gateway/interactive
          // tools would only bloat the model request and invite spurious
          // tool calls. Status/usage/compaction stay for every session.
          oneShot: this.host.isTitleSession(sessionId),
          questionCap,
          ...(bundledRuntime
            ? {
                sensitiveFilePolicyPath: storage.resolve(BUNDLED_PI_FILE_POLICY),
                sensitiveSecretRoot: storage.resolve(AGENT_SECRET_ROOT)
              }
            : {}),
          gatewayHandoffPath: storage.resolve(handoffRelative),
          systemPromptPath: storage.resolve(systemPromptRelative),
          historyRecapPath: storage.resolve(historyRecapRelative),
          allowedToolsPath: storage.resolve(allowedToolsRelative),
          oversizedFlagPath: storage.resolve(oversizedFlagRelative),
          stopFlagPath: storage.resolve(stopFlagRelative),
          handoffWorkersPath: storage.resolve(handoffWorkersRelative),
          liveSubagentsPath: storage.resolve(liveSubagentsRelative),
          subagentWatchPath: storage.resolve(watchFlagRelative),
          // Never seeded by this materialization: the engine publishes the
          // thread's plan and progress before the module exists on the first
          // turn, and a seed written here would overwrite it.
          compactionContextPath: storage.resolve(compactionContextRelative),
          // The primary agent's composed instructions ride the per-turn system
          // prompt handoff, which only the root session's hook reads. A worker
          // gets this distilled contract instead, so it can never be left with
          // none of the application rules.
          workerContractPrompt: WORKER_AGENT_BEHAVIOR_PROMPT,
          // The built-in-tool override rebuilds pi's own definitions, which
          // resolve every path against the session's working directory.
          sessionCwd
        })
      )
      this.gatewayHandoffPaths.set(sessionId, handoffRelative)
      this.cioSystemPromptPaths.set(sessionId, systemPromptRelative)
      this.cioHistoryRecapPaths.set(sessionId, historyRecapRelative)
      this.cioAllowedToolsPaths.set(sessionId, allowedToolsRelative)
      this.cioOversizedFlagPaths.set(sessionId, oversizedFlagRelative)
      this.cioStopFlagPaths.set(sessionId, stopFlagRelative)
      this.host.registerWatchPath(sessionId, watchFlagRelative)
      const extensionAbsolute = storage.resolve(extensionRelative)
      this.cioCoreToolsExtensionPaths.set(sessionId, extensionAbsolute)
      // Flush an endpoint that arrived before this materialization (first turn
      // of a fresh session); the handoff file still holds the empty seed otherwise.
      const pendingEndpoint = this.pendingGatewayEndpoints.get(sessionId)
      if (pendingEndpoint) {
        this.pendingGatewayEndpoints.delete(sessionId)
        await storage.writeRaw(handoffRelative, JSON.stringify(pendingEndpoint))
      }
      return extensionAbsolute
    } catch (error) {
      Logger.dev('Pi cio-core-tools extension materialization failed:', error)
      return null
    }
  }

  /**
   * Publish the turn-scoped gateway endpoint for the app-owned utility gateway
   * extension. Pi sessions are persistent RPC processes whose extensions load
   * at spawn, so the per-turn URL+token reach the extension through a
   * session-keyed handoff file the driver rewrites per turn; clearing it on
   * turn end makes stale tokens unusable. Publishing must succeed before the
   * model starts; there is no model-facing shell fallback.
   */
  async publishUtilityGatewayEndpoint(
    sessionId: string,
    endpoint: UtilityGatewayEndpoint | null
  ): Promise<void> {
    const handoffPath = this.gatewayHandoffPaths.get(sessionId)
    if (!handoffPath) {
      if (endpoint !== null) {
        // First turn of a fresh session: the extension materializes only inside
        // ensureRpcClient (during sendPrompt), which runs after this publish.
        // Defer the endpoint instead of dropping it so the spawned session starts
        // with a working gateway rather than the empty { url: '', token: '' } seed.
        this.pendingGatewayEndpoints.set(sessionId, endpoint)
        Logger.dev('Pi utility gateway endpoint deferred: extension not yet materialized')
      } else {
        this.pendingGatewayEndpoints.delete(sessionId)
      }
      return
    }
    try {
      const storage = this.host.storageFor(sessionId)
      // Which file surface a turn's handoff lands on is the whole difference
      // between a gateway that works on an Oven and one that silently keeps the
      // empty seed there, so the publish names the root it wrote to.
      Logger.dev('Pi utility gateway handoff published', {
        sessionId,
        empty: endpoint === null,
        root: storage.resolve(cioCoreToolsDirectory(sessionId))
      })
      if (endpoint === null) await storage.remove(handoffPath)
      else {
        await storage.writeRaw(handoffPath, JSON.stringify(endpoint))
      }
    } catch (error) {
      throw new Error('Pi utility gateway handoff update failed', { cause: error })
    }
  }

  /**
   * Publish the plan and progress the owning thread is executing, so the
   * compaction extension can rebuild a checkpoint from them when a transcript
   * cannot be summarized. Session-keyed and best-effort: a thread with no plan
   * (or a harness without rebuild support) simply publishes an empty snapshot.
   */
  async publishCompactionContext(
    sessionId: string,
    context: CompactionFallbackContext | null
  ): Promise<void> {
    const relative = join(cioCoreToolsDirectory(sessionId), 'compaction-context.json')
    try {
      await this.host
        .storageFor(sessionId)
        .writeRaw(
          relative,
          JSON.stringify(
            context ?? { plan: null, progress: null, planPath: null, progressPath: null }
          )
        )
    } catch (error) {
      // Rebuild context is a fallback, never a reason to fail a turn.
      Logger.dev('Pi compaction context publish failed:', error)
    }
  }

  /** Publish the user's stop, or the stop a thread move performs, into the
   *  session's stop-flag file. `reason` is the only thing that tells the
   *  extension whether the workers it owns must end (a user stop) or be handed
   *  to the adopting instance with their session files intact (a move). */
  async publishStopRequest(
    sessionId: string,
    childSessionIds?: string[],
    reason?: 'user' | 'transfer'
  ): Promise<void> {
    const path = this.cioStopFlagPaths.get(sessionId)
    if (!path) return
    this.stopRequestSeq += 1
    try {
      await this.host.storageFor(sessionId).writeRaw(
        path,
        JSON.stringify({
          token: `${Date.now()}-${this.stopRequestSeq}`,
          requestedAt: Date.now(),
          childSessionIds: childSessionIds ?? [],
          reason: reason ?? 'user'
        })
      )
    } catch (error) {
      Logger.dev('Pi stop-request publication failed:', error)
    }
  }

  /** Write a seed flag file only when nothing wrote it first. */
  private async seedIfMissing(sessionId: string, relative: string, content: string): Promise<void> {
    const storage = this.host.storageFor(sessionId)
    if ((await storage.readRaw(relative)) !== null) return
    await storage.writeRaw(relative, content)
  }

  /**
   * Publish the workers a thread move must continue on the adopting instance.
   *
   * The path is derived from the session id, so this works before the session's
   * extension is materialized in this process: the extension reads the roster
   * on the resumed thread's first agent start and clears it in the same step,
   * which is what keeps a later turn from starting the same worker twice.
   */
  async publishHandoffWorkers(
    sessionId: string,
    workers: readonly HandoffWorkerSession[]
  ): Promise<void> {
    const relative = join(cioCoreToolsDirectory(sessionId), 'handoff-workers.json')
    try {
      await this.host.storageFor(sessionId).writeRaw(relative, JSON.stringify({ workers }))
    } catch (error) {
      Logger.dev('Pi handed-off worker publication failed:', error)
    }
  }

  /**
   * Disarm the stop request. A new user turn is not a continuation of a stop,
   * so the extension must never apply an old token to its workers.
   */
  async clearStopRequest(sessionId: string): Promise<void> {
    const path = this.cioStopFlagPaths.get(sessionId)
    if (!path) return
    try {
      await this.host.storageFor(sessionId).writeRaw(path, JSON.stringify(emptyStopRequest()))
    } catch (error) {
      Logger.dev('Pi stop-request reset failed:', error)
    }
  }

  /** Rewrite the session's oversized-recovery arm/disarm flag file. A missing
   *  materialized path (extension failed to load) means the next provider
   *  request goes out unmodified   never blocks the turn. */
  async publishOversizedRecovery(sessionId: string, armed: boolean): Promise<void> {
    const path = this.cioOversizedFlagPaths.get(sessionId)
    if (!path) return
    try {
      await this.host.storageFor(sessionId).writeRaw(path, JSON.stringify({ armed }))
    } catch (error) {
      Logger.dev('Pi core-tools oversized-recovery flag update failed:', error)
    }
  }

  /** Rewrite the session's CIO system-prompt handoff file so the extension's
   *  `before_agent_start` hook picks it up on the next agent loop start. A
   *  missing materialized path (extension failed to load) means the turn
   *  falls back to Pi's own system prompt only   never blocks the turn. */
  async publishCioSystemPrompt(sessionId: string, systemPrompt: string): Promise<void> {
    const path = this.cioSystemPromptPaths.get(sessionId)
    if (!path) return
    try {
      await this.host.storageFor(sessionId).writeRaw(path, systemPrompt)
    } catch (error) {
      Logger.dev('Pi core-tools system-prompt handoff update failed:', error)
    }
  }

  /** Rewrite the session's restored-history handoff file. The extension's
   *  `context` hook reads it before every LLM call and injects its content as
   *  its own leading user message; an empty file clears the injection. Every
   *  turn publishes (including an empty recap) so a later turn can never
   *  inherit a stale replay. Never blocks the turn when the extension was not
   *  materialized. */
  async publishCioHistoryRecap(sessionId: string, recap: string): Promise<void> {
    const path = this.cioHistoryRecapPaths.get(sessionId)
    if (!path) return
    try {
      await this.host.storageFor(sessionId).writeRaw(path, recap.trim())
    } catch (error) {
      Logger.dev('Pi core-tools history-recap handoff update failed:', error)
    }
  }

  /** Rewrite the session's allowed-tools handoff file so the extension's tool
   *  gate reflects the current permission scope (web-only chat vs. file
   *  access). Undefined/empty publishes an unrestricted session. Never blocks
   *  the turn when the extension was not materialized. */
  async publishCioAllowedTools(sessionId: string, allowedTools?: string[]): Promise<void> {
    const path = this.cioAllowedToolsPaths.get(sessionId)
    if (!path) return
    try {
      // Some allowlists are authored in OpenCode tool naming; map the aliases
      // onto pi's built-in tool names so the gate matches intent.
      const aliases: Record<string, string> = { glob: 'find', list: 'ls' }
      const names = (allowedTools ?? []).map((tool) => aliases[tool] ?? tool)
      await this.host.storageFor(sessionId).writeRaw(path, JSON.stringify(names))
    } catch (error) {
      Logger.dev('Pi core-tools allowed-tools handoff update failed:', error)
    }
  }

  /** Remove a session's gateway handoff file and forget its path. */
  async removeGatewayHandoff(sessionId: string): Promise<void> {
    const handoffPath = this.gatewayHandoffPaths.get(sessionId)
    if (!handoffPath) {
      this.pendingGatewayEndpoints.delete(sessionId)
      return
    }
    this.gatewayHandoffPaths.delete(sessionId)
    this.pendingGatewayEndpoints.delete(sessionId)
    try {
      await this.host.storageFor(sessionId).remove(handoffPath)
    } catch (error) {
      Logger.dev('Pi utility gateway handoff removal failed:', error)
    }
  }

  /** Resolved key env for the session's custom-providers extension. */
  providerExtensionEnv(sessionId: string): Record<string, string> | undefined {
    return this.cioProvidersExtensionEnvs.get(sessionId)
  }

  setProviderExtensionEnv(sessionId: string, env: Record<string, string>): void {
    this.cioProvidersExtensionEnvs.set(sessionId, env)
  }

  /** Forget the session's providers-extension key env (its process is gone). */
  forgetSession(sessionId: string): void {
    this.cioProvidersExtensionEnvs.delete(sessionId)
  }

  /** Drop every session's runtime file record (driver disposal). */
  clear(): void {
    this.cioStopFlagPaths.clear()
    for (const sessionId of this.gatewayHandoffPaths.keys()) {
      void this.removeGatewayHandoff(sessionId)
    }
    this.gatewayHandoffPaths.clear()
    this.pendingGatewayEndpoints.clear()
    this.cioCoreToolsExtensionPaths.clear()
    this.cioSystemPromptPaths.clear()
    this.cioHistoryRecapPaths.clear()
    this.cioAllowedToolsPaths.clear()
    this.cioOversizedFlagPaths.clear()
    this.cioProvidersExtensionEnvs.clear()
  }
}
