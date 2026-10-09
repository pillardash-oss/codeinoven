import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  AgentMessage,
  PromptAttachment,
  Thread,
  ThreadSettings,
  PermissionReply,
  HarnessAccount,
  PermissionRequest,
  PendingAgentQuestionRequest
} from '../../lib/types'
import { LOCAL_OVEN_ID } from '../../lib/ovens'
import type { OvenAppearance, OvenFile } from '../../lib/ovens'
import type { ThreadManager } from '../../lib/engines/thread-manager'
import type { ProjectManager } from '../../lib/engines/project-manager'
import type { StorageEngine } from '../storage/storage-engine'
import type { HarnessAccountRegistry } from '../providers/harness-account-registry'
import { OvenRegistry } from './oven-registry'
import { resolveOvenThreadRoot } from './oven-thread-root'
import { OvenService } from './oven-service'
import { syncOvenAccount } from './oven-accounts'
import type { SecretVault } from '../storage/secret-vault'
import type {
  PersistentCliSession,
  CliLineParseResult
} from '../drivers/persistent-cli/persistent-cli-types'
import { parseCodexJsonLine } from '../drivers/codex/codex-stream-fold'
import { mapClaudeCodeRecord } from '../drivers/claude-code/claude-stream-fold'
import { mapPiRecord } from '../drivers/pi/pi-stream-fold'
import { mapMuseRecord } from '../drivers/muse/muse-stream-fold'
import { mapClineRecord } from '../drivers/cline/cline-stream-fold'
import type { MuseTurnState } from '../drivers/muse/muse-parts'
import type { PiTurnState } from '../drivers/pi/pi-stream-types'
import {
  foldEventIntoMessages,
  mergeSessionMessages
} from '../drivers/persistent-cli/persistent-cli-transcript'
import { Logger } from '../system/logger'

interface Binding {
  projectId: string
  threadId: string
  ovenId: string
  ovenLabel: string
  ovenAppearance: OvenAppearance
  root: string
  runId: string
  session: PersistentCliSession
  settings: ThreadSettings
  before: AgentMessage[]
  finished: boolean
  createdAt: number
  resolved?: string[]
}

interface Live {
  binding: Binding
  after: number
  buffer: string
  stderr: string
  polling?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  pi: PiTurnState
  muse: MuseTurnState
  pending: Map<string, { input: Record<string, unknown>; request: PermissionRequest }>
  questions: Map<string, PendingAgentQuestionRequest>
  closedInput: boolean
  /**
   * Milliseconds added to a timestamp the harness stamped with the clock of
   * the host it runs on, measured once per run by `alignHarnessClock`.
   */
  clockOffset?: number
  /** Latest timestamp the run has placed on this machine's clock. */
  clockCursor?: number
}

/**
 * The one error the Oven service raises for a run it does not know.
 *
 * A service update or restart drops the in-memory run map, so a run the desktop
 * is still polling can disappear; this is the signal that it is gone for good
 * rather than a transport failure worth retrying.
 */
const MISSING_RUN = 'The remote run does not exist.'

/** Remote turns bypass desktop repository work. Only transcript metadata stays here. */
export class OvenChat {
  readonly service: OvenService
  private readonly registry: OvenRegistry
  private readonly live = new Map<string, Live>()
  private readonly starting = new Set<string>()
  private disposed = false

  constructor(
    private readonly storage: StorageEngine,
    vault: SecretVault,
    private readonly threads: ThreadManager,
    private readonly accounts: HarnessAccountRegistry,
    private readonly projects: ProjectManager,
    private readonly publish: (event: AgentEvent) => void
  ) {
    this.registry = new OvenRegistry(storage, vault)
    this.service = new OvenService(this.registry)
  }

  async nameFor(ovenId: string): Promise<string> {
    if (ovenId === LOCAL_OVEN_ID) return 'Local'
    return (await this.registry.require(ovenId)).name
  }

  async appearanceFor(ovenId: string): Promise<OvenAppearance> {
    const oven = (await this.registry.state()).ovens.find((item) => item.id === ovenId)
    if (!oven) throw new Error('This Oven no longer exists.')
    return {
      icon: oven.icon,
      color: oven.color,
      ...(oven.customSvg ? { customSvg: oven.customSvg } : {})
    }
  }

  remote(thread: Thread, settings = thread.settings): boolean {
    return !!settings?.ovenId && settings.ovenId !== LOCAL_OVEN_ID
  }

  private path(thread: Pick<Thread, 'projectId' | 'id'>): string {
    return `ovens/threads/${thread.projectId}/${thread.id}.json`
  }

  private makeLive(binding: Binding): Live {
    return {
      binding,
      after: 0,
      buffer: '',
      stderr: '',
      pi: { assistantMessageId: null, turnIndex: 0 },
      muse: {
        turnIndex: 1,
        messageId: `${binding.runId}:assistant`,
        createdAt: binding.createdAt,
        text: '',
        reasoning: '',
        parts: [],
        started: false,
        tools: new Map(),
        toolByCall: new Map(),
        promotedInteractions: new Set(),
        emittedPermissionTasks: new Set(),
        gatedTaskIds: new Set(),
        expectsProcessStop: false
      },
      pending: new Map(),
      questions: new Map(),
      closedInput: false
    }
  }

  async assertIdle(thread: Thread): Promise<void> {
    if (this.starting.has(thread.id))
      throw new Error('Wait for the Oven turn to start before switching.')
    const binding = await this.storage.read<Binding>(this.path(thread))
    if (!binding || binding.finished) return
    const { run } = await this.service.events(binding.ovenId, binding.runId, 0)
    if (run.status === 'running')
      throw new Error('Stop or finish the active turn before changing Ovens.')
  }

  async send(
    thread: Thread,
    settings: ThreadSettings,
    text: string,
    attachments: PromptAttachment[],
    userMessageId?: string,
    context = ''
  ): Promise<AgentMessage> {
    if (this.starting.has(thread.id)) throw new Error('A turn is already starting on this Oven.')
    this.starting.add(thread.id)
    let sessionId: string | undefined
    try {
      await this.assertNotRunning(thread)
      const ovenId = settings.ovenId!
      const ovenLabel = await this.nameFor(ovenId)
      const ovenAppearance = await this.appearanceFor(ovenId)
      const startedAt = Date.now()
      const account = await this.accounts.resolveForProvider(
        settings.harnessId,
        settings.providerId,
        settings.accountId
      )
      sessionId = thread.sessionId?.startsWith('oven-') ? thread.sessionId : `oven-${randomUUID()}`
      const turnSessionId = sessionId
      // Bind the session before preparation: the renderer routes the notes below
      // to this thread through it, so the working trace can say what the Oven is
      // doing while the checkout is still being prepared.
      await this.threads.setSessionId(
        thread.projectId,
        thread.id,
        turnSessionId,
        settings.harnessId,
        account.id
      )
      await this.threads.setStatus(thread.projectId, thread.id, 'executing')
      this.publishNote(turnSessionId, startedAt, `Preparing the project on ${ovenLabel}…`)
      const prepared = await resolveOvenThreadRoot(
        this.service,
        { ...thread, settings },
        this.projects,
        (step) =>
          this.publishNote(
            turnSessionId,
            startedAt,
            step === 'clone'
              ? `Cloning the repository onto ${ovenLabel}…`
              : `Opening the checkout on ${ovenLabel}…`
          )
      )
      const { root, dataRoot, sessionsRoot } = prepared
      if (prepared.branch && prepared.branch !== thread.branch)
        await this.threads.setBranch(thread.projectId, thread.id, prepared.branch)
      await this.threads.updateSettings(thread.projectId, thread.id, {
        ...settings,
        ovenPath: root
      })
      if (settings.harnessId === 'pi') {
        await this.service.workspace(ovenId, { operation: 'ensure', root: sessionsRoot })
        await this.adoptLegacyPiSessions(ovenId, dataRoot, root)
      }
      const environment = await syncOvenAccount(this.service, this.accounts, ovenId, account)
      if (settings.harnessId === 'cline') environment.CLINE_SESSION_BACKEND_MODE = 'local'
      const previous = await this.storage.read<Binding>(this.path(thread))
      const messages = await this.threads.loadMessages(thread.projectId, thread.id)
      const userId = userMessageId || randomUUID()
      const user: AgentMessage = {
        id: userId,
        role: 'user',
        ovenId,
        ovenLabel,
        ovenAppearance,
        accountId: account.id,
        accountLabel: account.label,
        thinkingLevel: settings.thinkingLevel,
        createdAt: Date.now(),
        parts: [
          { type: 'text', id: `${userId}:text`, messageID: userId, text },
          ...attachments.map((attachment, index) => ({
            type: 'file' as const,
            id: `${userId}:file:${index}`,
            messageID: userId,
            ...attachment
          }))
        ]
      }
      if (!messages.some((message) => message.id === userId)) messages.push(user)
      const nativeSessionId =
        previous?.ovenId === ovenId &&
        previous.root === root &&
        previous.settings.harnessId === settings.harnessId &&
        previous.settings.accountId === account.id
          ? (previous.session.nativeSessionId ??
            (settings.harnessId === 'pi' ? previous.session.id : undefined))
          : undefined
      const runId = randomUUID()
      const session: PersistentCliSession = {
        id: sessionId,
        title: thread.title,
        projectPathHash: root,
        nativeSessionId,
        threadId: thread.id,
        messages,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      const paths = await this.attachments(ovenId, root, attachments)
      const history = !nativeSessionId
        ? messages
            .slice(-25, -1)
            .map(
              (message) =>
                `${message.role}: ${message.parts
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text)
                  .join('\n')}`
            )
            .join('\n\n')
            .slice(-80_000)
        : ''
      const prompt = [
        history ? `Previous conversation:\n${history}` : '',
        context,
        text,
        paths.length ? `Attached files in this workspace:\n${paths.join('\n')}` : ''
      ]
        .filter(Boolean)
        .join('\n\n')
      const invocation = this.command(settings, session, prompt, paths, account, sessionsRoot)
      const binding: Binding = {
        projectId: thread.projectId,
        threadId: thread.id,
        ovenId,
        ovenLabel,
        ovenAppearance,
        root,
        runId,
        session,
        settings: { ...settings, ovenPath: root, accountId: account.id },
        before: structuredClone(messages),
        finished: false,
        createdAt: Date.now()
      }
      await this.storage.write(this.path(thread), binding)
      await this.threads.updateSettings(thread.projectId, thread.id, binding.settings)
      await this.threads.setSessionId(
        thread.projectId,
        thread.id,
        sessionId,
        settings.harnessId,
        account.id
      )
      await this.threads.upsertMessages(thread.projectId, thread.id, messages)
      await this.service.start(ovenId, { id: runId, cwd: root, environment, ...invocation })
      await this.threads.setStatus(thread.projectId, thread.id, 'executing')
      const live = this.makeLive(binding)
      this.live.set(thread.id, live)
      this.publish({
        type: 'session.status',
        sessionId,
        status: { state: 'working', startedAt: binding.createdAt }
      })
      this.schedule(live, 0)
      return user
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start the Oven turn.'
      // A turn that never started must still clear its working state, or the
      // trace keeps a spinner for a run that does not exist.
      if (sessionId) {
        this.publish({ type: 'session.error', sessionId, error: message })
        this.publish({ type: 'session.idle', sessionId })
      }
      await this.threads.setStatus(thread.projectId, thread.id, 'failed', { error: message })
      throw error
    } finally {
      this.starting.delete(thread.id)
    }
  }

  private async assertNotRunning(thread: Thread): Promise<void> {
    const existing = await this.storage.read<Binding>(this.path(thread))
    if (!existing || existing.finished) return
    let result: Awaited<ReturnType<OvenService['events']>>
    try {
      result = await this.service.events(existing.ovenId, existing.runId, 0)
    } catch (error) {
      if (error instanceof Error && error.message === MISSING_RUN) {
        existing.finished = true
        await this.storage.write(this.path(thread), existing)
        return
      }
      throw error
    }
    if (result.run.status === 'running')
      throw new Error('This Oven already has an active turn for this chat.')
    await this.restore(thread)
    const live = this.live.get(thread.id)
    if (live) await this.pollToEnd(live)
  }

  private command(
    settings: ThreadSettings,
    session: PersistentCliSession,
    prompt: string,
    paths: string[],
    account: HarnessAccount,
    sessionsRoot: string
  ): { command: string; args: string[]; input?: string; closeInput?: boolean } {
    const model = settings.modelId
    const full = settings.permissionLevel === 'full_access'
    const native = session.nativeSessionId
    switch (settings.harnessId) {
      case 'codex':
        return {
          command: 'codex',
          args: [
            ...(full ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
            'exec',
            ...(native ? ['resume', native] : []),
            '--json',
            ...(!full
              ? native
                ? ['-c', 'sandbox_mode="workspace-write"']
                : ['--sandbox', 'workspace-write']
              : []),
            ...(model ? ['--model', model] : []),
            '-c',
            `model_reasoning_effort=${JSON.stringify(settings.thinkingLevel === 'max' || settings.thinkingLevel === 'ultra' ? 'xhigh' : settings.thinkingLevel)}`,
            ...paths
              .filter((path) => /\.(?:png|jpe?g|webp|gif)$/iu.test(path))
              .flatMap((path) => ['--image', path]),
            prompt
          ],
          closeInput: true
        }
      case 'claude-code':
        return {
          command: 'claude',
          args: [
            '-p',
            '--output-format',
            'stream-json',
            '--input-format',
            'stream-json',
            '--verbose',
            '--include-partial-messages',
            '--permission-prompt-tool',
            'stdio',
            ...(native ? ['--resume', native] : []),
            ...(model ? ['--model', model] : []),
            '--permission-mode',
            full ? 'bypassPermissions' : 'manual'
          ],
          input: `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null })}\n`
        }
      case 'pi':
        return {
          command: 'pi',
          args: [
            '--mode',
            'json',
            '--print',
            '--session',
            `${sessionsRoot}/${session.id}.jsonl`,
            ...(settings.providerId ? ['--provider', settings.providerId] : []),
            ...(model ? ['--model', model] : []),
            '--thinking',
            settings.thinkingLevel === 'max' || settings.thinkingLevel === 'ultra'
              ? 'xhigh'
              : settings.thinkingLevel,
            prompt
          ],
          closeInput: true
        }
      case 'opencode':
        return {
          command: 'opencode',
          args: [
            'run',
            '--format',
            'json',
            ...(native ? ['--session', native] : []),
            ...(model
              ? ['--model', model.includes('/') ? model : `${settings.providerId}/${model}`]
              : []),
            ...paths.flatMap((path) => ['--file', path]),
            prompt
          ],
          closeInput: true
        }
      case 'muse':
        return {
          command: 'muse',
          args: [
            'exec',
            '--json',
            '--no-foreign-personal-context',
            ...(full ? ['--yolo'] : []),
            ...(model ? ['--model', model] : []),
            ...(settings.providerId ? ['--provider', settings.providerId] : []),
            prompt
          ],
          closeInput: true
        }
      case 'cline':
        return {
          command: 'cline',
          args: [
            '--json',
            ...(model ? ['-m', model] : []),
            ...(settings.providerId ? ['-P', settings.providerId] : []),
            '--auto-approve',
            String(full),
            '-c',
            session.projectPathHash,
            /\s/u.test(prompt) ? prompt : `${prompt}\n`
          ],
          closeInput: true
        }
      default:
        throw new Error(
          `The Oven cannot run ${account.harnessId}. Choose an installed CLI harness.`
        )
    }
  }

  /**
   * One preparation note for a running turn.
   *
   * Statuses with the same session id replace each other, so the note is what
   * the working trace shows until the harness itself starts streaming.
   */
  private publishNote(sessionId: string, startedAt: number, note: string): void {
    this.publish({
      type: 'session.status',
      sessionId,
      status: { state: 'working', startedAt, note }
    })
  }

  /**
   * Adopt pi session transcripts older releases wrote into the checkout root.
   *
   * `--session <checkout>/.cio-pi-<id>.jsonl` used to place an app-owned
   * transcript inside the user's repository. The file is moved (never deleted)
   * into the Oven's session directory so the session it names keeps resuming
   * and the checkout stops showing app state as untracked files. A move that
   * cannot complete leaves the legacy file exactly where it was.
   */
  private async adoptLegacyPiSessions(
    ovenId: string,
    dataRoot: string,
    root: string
  ): Promise<void> {
    const prefix = root === dataRoot ? '' : `${dataRoot}/`
    if (prefix && !root.startsWith(prefix)) return
    const relativeRoot = prefix ? root.slice(prefix.length) : ''
    let files: OvenFile[]
    try {
      files =
        (await this.service.workspace(ovenId, { operation: 'list', root, path: '.' })).files ?? []
    } catch {
      return
    }
    for (const file of files) {
      const match = /^\.cio-pi-(.+)\.jsonl$/u.exec(file.path)
      if (!match || file.kind !== 'file') continue
      const path = relativeRoot ? `${relativeRoot}/${file.path}` : file.path
      await this.service
        .workspace(ovenId, {
          operation: 'move',
          root: dataRoot,
          path,
          to: `sessions/${match[1]}.jsonl`
        })
        .catch((error: unknown) =>
          Logger.dev('A legacy Oven pi session was left in the checkout', {
            ovenId,
            path,
            error: error instanceof Error ? error.message : String(error)
          })
        )
    }
  }

  private async attachments(
    ovenId: string,
    root: string,
    attachments: PromptAttachment[]
  ): Promise<string[]> {
    const result: string[] = []
    if (attachments.length > 20) throw new Error('Attach at most 20 files per Oven turn.')
    if (attachments.length)
      await this.service.workspace(ovenId, {
        operation: 'mkdir',
        root,
        path: '.cio/tmp/attachments'
      })
    for (const attachment of attachments) {
      const { localAttachmentPath } = await import('../drivers/codex/codex-prompts')
      const { readFile, stat } = await import('node:fs/promises')
      const local = await localAttachmentPath(attachment)
      const info = await stat(local)
      if (info.size > 8 * 1024 * 1024)
        throw new Error('Oven attachments must be no larger than 8 MiB.')
      const filename = (attachment.filename ?? 'attachment')
        .replace(/[^a-zA-Z0-9._-]/gu, '_')
        .slice(-120)
      const path = `.cio/tmp/attachments/${randomUUID()}-${filename}`
      await this.service.putFile(ovenId, root, path, await readFile(local))
      result.push(`${root}/${path}`)
    }
    return result
  }

  async restore(thread: Thread): Promise<void> {
    if (this.live.has(thread.id) || this.disposed) return
    const binding = await this.storage.read<Binding>(this.path(thread))
    if (!binding || binding.finished) return
    binding.session.messages = structuredClone(binding.before)
    const live = this.makeLive(binding)
    this.live.set(thread.id, live)
    this.publish({
      type: 'session.status',
      sessionId: binding.session.id,
      status: { state: 'working', startedAt: binding.createdAt }
    })
    try {
      await this.poll(live)
    } catch {
      // A failed first reconnect must keep retrying rather than leave a live
      // binding with no timer. Remote work continues while transport is down.
      this.schedule(live, 5000)
    }
  }

  async messages(thread: Thread): Promise<AgentMessage[]> {
    await this.restore(thread)
    return (
      this.live.get(thread.id)?.binding.session.messages ??
      (await this.threads.loadMessages(thread.projectId, thread.id))
    )
  }

  private schedule(live: Live, delay = 1000): void {
    if (this.disposed || live.binding.finished) return
    live.timer = setTimeout(() => {
      void this.poll(live).catch((error: unknown) => {
        Logger.dev('Oven connection interrupted; reconnecting', {
          ovenId: live.binding.ovenId,
          error: error instanceof Error ? error.message : 'Connection unavailable'
        })
        this.schedule(live, 5000)
      })
    }, delay)
    live.timer.unref()
  }

  private async pollToEnd(live: Live): Promise<void> {
    for (let page = 0; page < 512 && !live.binding.finished; page++) await this.poll(live)
    if (!live.binding.finished)
      throw new Error('The previous transcript is still synchronizing. Try again shortly.')
  }

  private poll(live: Live): Promise<void> {
    if (live.polling) return live.polling
    const task = this.consume(live).finally(() => {
      live.polling = undefined
    })
    live.polling = task
    return task
  }

  private async consume(live: Live): Promise<void> {
    if (this.disposed || live.binding.finished) return
    if (live.timer) clearTimeout(live.timer)
    const binding = live.binding
    let page: Awaited<ReturnType<OvenService['events']>>
    try {
      page = await this.service.events(binding.ovenId, binding.runId, live.after)
    } catch (error) {
      // An Oven service update or restart drops its in-memory runs, so a run the
      // client is still polling can vanish. Retrying forever left the turn stuck
      // as "working" with Stop unable to clear it; the run is gone either way, so
      // settle the turn instead.
      if (error instanceof Error && error.message === MISSING_RUN) {
        await this.finish(live, 'interrupted', {
          error: 'This turn is no longer running on the Oven, so it was ended.'
        })
        return
      }
      throw error
    }
    let exit = false
    for (const event of page.events) {
      if (event.stream === 'stdout') {
        live.buffer += event.text
        if (Buffer.byteLength(live.buffer) > 1024 * 1024)
          throw new Error('The harness emitted a record larger than 1 MiB.')
        let newline: number
        while ((newline = live.buffer.indexOf('\n')) >= 0) {
          const line = live.buffer.slice(0, newline)
          live.buffer = live.buffer.slice(newline + 1)
          await this.record(live, line)
        }
      } else if (event.stream === 'stderr') live.stderr = `${live.stderr}${event.text}`.slice(-4000)
      else exit = true
      live.after = event.sequence
    }
    if (exit || (page.run.status !== 'running' && page.events.length === 0)) {
      if (live.buffer.trim()) await this.record(live, live.buffer)
      const failed = page.run.status === 'failed'
      await this.finish(
        live,
        page.run.status === 'stopped' ? 'interrupted' : failed ? 'failed' : 'completed',
        failed
          ? {
              error: `Oven harness exited with code ${page.run.exitCode ?? 'unknown'}.`,
              errorDetail: live.stderr
            }
          : undefined
      )
    }
    await this.threads.upsertMessages(binding.projectId, binding.threadId, binding.session.messages)
    await this.storage.write(
      this.path({ projectId: binding.projectId, id: binding.threadId }),
      binding
    )
    if (!binding.finished) this.schedule(live, page.events.length >= 128 ? 0 : 1000)
    else this.live.delete(binding.threadId)
  }

  /**
   * End one live turn: settle its thread status, clear the working state, and
   * mark the binding finished so no later poll resumes it.
   *
   * Idempotent, because the ways a turn can end   the harness exiting, the user
   * stopping it, and the run vanishing from the Oven   race each other.
   */
  private async finish(
    live: Live,
    status: 'completed' | 'failed' | 'interrupted',
    failure?: { error: string; errorDetail?: string }
  ): Promise<void> {
    const binding = live.binding
    if (binding.finished) return
    binding.finished = true
    if (live.timer) clearTimeout(live.timer)
    live.timer = undefined
    await this.threads.setStatus(
      binding.projectId,
      binding.threadId,
      status,
      failure
        ? {
            error: failure.error,
            ...(failure.errorDetail ? { errorDetail: failure.errorDetail } : {})
          }
        : undefined
    )
    if (failure)
      this.publish({
        type: 'session.error',
        sessionId: binding.session.id,
        error: failure.error,
        ...(failure.errorDetail ? { rawError: failure.errorDetail } : {})
      })
    this.publish({ type: 'session.idle', sessionId: binding.session.id })
    this.publish({
      type: 'session.status',
      sessionId: binding.session.id,
      status: { state: 'idle' }
    })
    await this.storage.write(
      this.path({ projectId: binding.projectId, id: binding.threadId }),
      binding
    )
  }

  private async record(live: Live, line: string): Promise<void> {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return
    }
    const binding = live.binding
    const context = {
      session: binding.session,
      sessionId: binding.session.id,
      projectPath: binding.root
    }
    let mapped: CliLineParseResult | null
    switch (binding.settings.harnessId) {
      case 'codex':
        mapped = parseCodexJsonLine(value, context, {
          refreshContextUsage: async () => undefined,
          refreshRateLimits: async () => undefined
        })
        break
      case 'claude-code':
        mapped = mapClaudeCodeRecord(value, context)
        break
      case 'pi':
        mapped = mapPiRecord(value, context, live.pi)
        break
      case 'muse':
        mapped = mapMuseRecord(value, context, live.muse)
        break
      case 'cline':
        mapped = mapClineRecord(value, context)
        break
      default:
        mapped = this.openCode(value, context.sessionId, binding.runId)
        break
    }
    if (!mapped) return
    if (mapped.nativeSessionId) binding.session.nativeSessionId = mapped.nativeSessionId
    if (mapped.messages) {
      this.alignHarnessClock(live, mapped.messages)
      for (const message of mapped.messages) {
        message.ovenId ??= binding.ovenId
        message.ovenLabel ??= binding.ovenLabel
        message.ovenAppearance ??= binding.ovenAppearance
        message.accountId ??= binding.settings.accountId
        message.thinkingLevel ??= binding.settings.thinkingLevel
      }
      mergeSessionMessages(
        binding.session,
        mapped.messages,
        binding.settings,
        binding.settings.harnessId
      )
    }
    for (const event of mapped.events ?? []) {
      foldEventIntoMessages(binding.session.messages, event)
      if (event.type === 'permission.asked') {
        if (binding.resolved?.includes(event.permission.id)) continue
        const metadata = event.permission.metadata as Record<string, unknown> | undefined
        live.pending.set(event.permission.id, {
          input: (metadata?.input as Record<string, unknown>) ?? {},
          request: event.permission
        })
      } else if (event.type === 'question.asked') {
        if (binding.resolved?.includes(event.requestId)) continue
        live.questions.set(event.requestId, {
          ...event,
          projectId: binding.projectId,
          threadId: binding.threadId,
          createdAt: Date.now(),
          activeQuestionIndex: 0,
          answers: [],
          interactedQuestionIndexes: []
        })
      }
      this.publish(event)
    }
    if (
      binding.settings.harnessId === 'claude-code' &&
      typeof value === 'object' &&
      value &&
      'type' in value &&
      value.type === 'result' &&
      !live.closedInput
    ) {
      live.closedInput = true
      await this.service.write(binding.ovenId, binding.runId, '', true)
    }
  }

  /**
   * Land harness timestamps on this machine's clock.
   *
   * A harness stamps its records with the clock of the host it runs on, and an
   * Oven is a different host: a virtual machine that resumes from suspend keeps
   * a clock that is hours behind. Adopted verbatim, a record stamped that way
   * sorts before the prompt that triggered it and reports a duration as long as
   * the skew.
   *
   * The window of trustworthy timestamps runs from the local moment the run
   * started, never earlier than the last message the desktop already held, up to
   * the moment the record arrived: nothing the run produces can predate the
   * prompt that triggered it or postdate our receiving it. A timestamp inside
   * the window is a locally stamped record, or a clock that caught up mid-turn,
   * and is left alone.
   *
   * The first timestamp outside the window fixes one offset for the whole run,
   * so the spacing the harness reported between its own records survives the
   * shift. That offset lands the record one millisecond after everything the
   * run has placed so far, which holds the run's own order together even if its
   * clock freezes or rewinds mid-turn.
   */
  private alignHarnessClock(live: Live, messages: AgentMessage[]): void {
    const binding = live.binding
    const previous = binding.before.at(-1)?.createdAt ?? 0
    const startedAt = Math.max(binding.createdAt, previous + 1)
    const received = Date.now()
    const align = (at: number): number => {
      let aligned = at
      if (at < startedAt || at > received) {
        const anchor = Math.max(startedAt, (live.clockCursor ?? 0) + 1)
        live.clockOffset ??= anchor - at
        aligned = at + live.clockOffset
      }
      live.clockCursor = Math.max(live.clockCursor ?? 0, aligned)
      return aligned
    }
    for (const message of messages) {
      message.createdAt = align(message.createdAt)
      if (message.completedAt !== undefined) message.completedAt = align(message.completedAt)
    }
  }

  private openCode(value: unknown, sessionId: string, runId: string): CliLineParseResult | null {
    if (!value || typeof value !== 'object') return null
    const entry = value as Record<string, unknown>
    const part = entry.part as Record<string, unknown> | undefined
    const nativeSessionId = typeof entry.sessionID === 'string' ? entry.sessionID : undefined
    if (entry.type !== 'text' || typeof part?.text !== 'string')
      return nativeSessionId ? { nativeSessionId } : null
    const messageId = `${runId}:assistant`
    const agentPart = {
      type: 'text' as const,
      id: typeof part.id === 'string' ? `${runId}:${part.id}` : `${runId}:text`,
      messageID: messageId,
      text: part.text
    }
    return {
      nativeSessionId,
      messages: [
        {
          id: messageId,
          role: 'assistant',
          createdAt: Date.now(),
          parts: [agentPart],
          harnessId: 'opencode'
        }
      ],
      events: [{ type: 'message.part.updated', sessionId, part: agentPart }]
    }
  }

  async stop(thread: Thread): Promise<void> {
    const binding = await this.storage.read<Binding>(this.path(thread))
    if (!binding || binding.finished) return
    try {
      await this.service.stop(binding.ovenId, binding.runId)
    } catch (error) {
      // A run the Oven no longer knows is already stopped. Failing here was what
      // left Stop   and the steer that stop-and-resends   unusable on a run that
      // had vanished, so settle it locally instead.
      if (!(error instanceof Error && error.message === MISSING_RUN)) throw error
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      let status: Awaited<ReturnType<OvenService['events']>>['run']['status']
      try {
        status = (await this.service.events(binding.ovenId, binding.runId, 0)).run.status
      } catch (error) {
        if (error instanceof Error && error.message === MISSING_RUN) break
        throw error
      }
      if (status !== 'running') break
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
    }
    await this.restore(thread)
    const live = this.live.get(thread.id)
    if (live) await this.pollToEnd(live)
  }

  async release(projectId: string, threadId: string): Promise<boolean> {
    const path = this.path({ projectId, id: threadId })
    const binding = await this.storage.read<Binding>(path)
    if (!binding) return false
    if (!binding.finished) await this.service.stop(binding.ovenId, binding.runId)
    const live = this.live.get(threadId)
    if (live) {
      live.binding.finished = true
      if (live.timer) clearTimeout(live.timer)
      await live.polling?.catch(() => undefined)
    }
    this.live.delete(threadId)
    await this.storage.remove(path)
    return true
  }

  async permission(
    projectId: string,
    requestId: string,
    reply: PermissionReply,
    message?: string
  ): Promise<boolean> {
    for (const live of this.live.values()) {
      const pending = live.pending.get(requestId)
      if (!pending || live.binding.projectId !== projectId) continue
      const response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: {
            behavior: reply === 'reject' ? 'deny' : 'allow',
            ...(reply === 'reject' ? {} : { updatedInput: pending.input }),
            ...(message ? { message } : {})
          }
        }
      }
      await this.service.write(
        live.binding.ovenId,
        live.binding.runId,
        `${JSON.stringify(response)}\n`
      )
      live.pending.delete(requestId)
      live.binding.resolved = [...(live.binding.resolved ?? []), requestId]
      await this.storage.write(
        this.path({ projectId: live.binding.projectId, id: live.binding.threadId }),
        live.binding
      )
      this.publish({
        type: 'permission.replied',
        sessionId: live.binding.session.id,
        requestId,
        reply
      })
      return true
    }
    return false
  }

  async permissions(thread: Thread): Promise<PermissionRequest[]> {
    await this.restore(thread)
    return [...(this.live.get(thread.id)?.pending.values() ?? [])].map((pending) => pending.request)
  }

  async questions(thread: Thread): Promise<PendingAgentQuestionRequest[]> {
    await this.restore(thread)
    return [...(this.live.get(thread.id)?.questions.values() ?? [])]
  }

  async answer(thread: Thread, requestId: string, answers: string[][] | null): Promise<void> {
    await this.restore(thread)
    const live = this.live.get(thread.id)
    const question = live?.questions.get(requestId)
    if (!live || !question) throw new Error('This Oven question is no longer pending.')
    if (
      answers &&
      (!Array.isArray(answers) ||
        answers.length !== question.questions.length ||
        answers.some(
          (batch) =>
            !Array.isArray(batch) ||
            batch.some((answer) => typeof answer !== 'string' || answer.length > 20_000)
        ))
    )
      throw new Error('Invalid question answers.')
    if (live.binding.settings.harnessId !== 'claude-code') {
      // These headless CLIs resume a question through a continuation turn, rather
      // than Claude's stdin control protocol. Preserve the resolution on replay.
      live.questions.delete(requestId)
      live.binding.resolved = [...(live.binding.resolved ?? []), requestId]
      await this.storage.write(this.path(thread), live.binding)
      this.publish({
        type: 'question.resolved',
        sessionId: live.binding.session.id,
        requestId,
        resolution: answers ? 'answered' : 'dismissed',
        ...(answers ? { answers } : {})
      })
      await this.stop(thread)
      const continuation = answers
        ? question.questions
            .map((item, index) => `${item.prompt}\n${answers[index].join(', ')}`)
            .join('\n\n')
        : 'The user dismissed the question. Continue without that answer or explain why the task cannot continue.'
      await this.send(
        thread,
        live.binding.settings,
        `The user responded to the earlier question through CodeInOven:\n${continuation}\nContinue from this response without repeating the same question.`,
        []
      )
      return
    }
    const input = question.metadata?.input as Record<string, unknown> | undefined
    const updatedInput = {
      ...input,
      answers: Object.fromEntries(
        question.questions.map((item, index) => [item.prompt, answers?.[index]?.join(', ') ?? ''])
      )
    }
    const response = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: answers
          ? { behavior: 'allow', updatedInput }
          : { behavior: 'deny', message: 'The user dismissed this question.' }
      }
    }
    await this.service.write(
      live.binding.ovenId,
      live.binding.runId,
      `${JSON.stringify(response)}\n`
    )
    live.questions.delete(requestId)
    live.binding.resolved = [...(live.binding.resolved ?? []), requestId]
    await this.storage.write(this.path(thread), live.binding)
    this.publish({
      type: 'question.resolved',
      sessionId: live.binding.session.id,
      requestId,
      resolution: answers ? 'answered' : 'dismissed',
      ...(answers ? { answers } : {})
    })
  }

  dispose(): void {
    this.disposed = true
    for (const live of this.live.values()) if (live.timer) clearTimeout(live.timer)
    this.live.clear()
    // Deliberately leave remote processes and service sockets owned by the Oven.
  }
}
