import type { AgentEvent, HarnessCommand, ProviderModel, ThreadSettings } from '../../../lib/types'
import { Logger } from '../../system/logger'
import { type TitleModelCandidate } from '../persistent-cli-driver'
import { mapCodexModel } from '../codex/codex-models'
import { type CodexAppServerHost, type CodexAppServerTurn } from '../codex/codex-protocol'
import { parseCodexConfigEdits } from '../codex/codex-tools'
import { numberValue, recordValue, stringValue } from '../codex/codex-values'
import type { CodexDriver } from '../codex-driver'

/** CodexDriver capabilities: one concern, moved verbatim from the composition root. */
export class CodexDriverCapabilities {
  constructor(
    private readonly host: CodexDriver,
    private readonly base: CodexDriver['base']
  ) {}

  async listCommands(projectPath: string): Promise<HarnessCommand[]> {
    const commands: HarnessCommand[] = [
      {
        name: 'config',
        description: 'Set Codex preferences with key=value arguments'
      },
      {
        name: 'settings',
        description: 'Set Codex preferences with key=value arguments'
      }
    ]
    let temporaryHost: CodexAppServerHost | null = null
    try {
      const host =
        this.host.hostsByProjectPath.has(projectPath) ||
        this.host.hostsStartingByProjectPath.has(projectPath)
          ? await this.host.units['runtime'].ensureAppServerHost(projectPath)
          : (temporaryHost = await this.host.units['runtime'].createAppServerHost(projectPath))
      const result = await this.host.units['runtime'].appServerRequest(host, 'skills/list', {
        cwds: [projectPath],
        forceReload: true
      })
      const rows = Array.isArray(result['data']) ? result['data'] : []
      const projectSkills = rows
        .map(recordValue)
        .find((row) => stringValue(row?.['cwd']) === projectPath)
      const skills =
        projectSkills && Array.isArray(projectSkills['skills']) ? projectSkills['skills'] : []
      for (const value of skills) {
        const skill = recordValue(value)
        const name = stringValue(skill?.['name'])
        if (!name || skill?.['enabled'] === false) continue
        const interfaceInfo = recordValue(skill?.['interface'])
        commands.push({
          name,
          description:
            stringValue(interfaceInfo?.['shortDescription']) ??
            stringValue(skill?.['description']) ??
            'Invoke this Codex skill',
          source: 'skill'
        })
      }
    } catch (error) {
      Logger.info('Codex skill command discovery skipped', {
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      if (temporaryHost) {
        this.host.units['runtime'].stopAppServerHost(
          temporaryHost,
          'Codex skill command discovery completed'
        )
      }
    }
    return commands
  }

  async runCommand(
    projectPath: string,
    sessionId: string,
    command: HarnessCommand,
    args: string,
    settings: ThreadSettings
  ): Promise<void> {
    if (command.source === 'skill') {
      const trimmedArgs = args.trim()
      await this.host.base.sendPrompt(projectPath, {
        sessionId,
        settings,
        text: `$${command.name}${trimmedArgs ? ` ${trimmedArgs}` : ''}`,
        attachments: []
      })
      return
    }
    if (command.name === 'config' || command.name === 'settings') {
      const edits = parseCodexConfigEdits(args, command.name)
      const host = await this.host.units['runtime'].ensureAppServerHost(projectPath)
      await this.host.units['runtime'].appServerRequest(host, 'config/batchWrite', { edits })
      return
    }
    throw new Error(`Command is not available in ${this.host.base.name}: ${command.name}`)
  }

  /** Cheapest candidates for any auxiliary one-shot run. */
  async cheapCandidateModels(projectPath: string): Promise<TitleModelCandidate[]> {
    return this.host.units['title'].cheapestCandidate(projectPath)
  }

  async discoverModels(projectPath: string): Promise<ProviderModel[]> {
    let temporaryHost: CodexAppServerHost | null = null
    try {
      const windows = await this.host.units['catalog'].codexWindowCatalog(projectPath)
      const host =
        this.host.hostsByProjectPath.has(projectPath) ||
        this.host.hostsStartingByProjectPath.has(projectPath)
          ? await this.host.units['runtime'].ensureAppServerHost(projectPath)
          : (temporaryHost = await this.host.units['runtime'].createAppServerHost(projectPath))
      const discovered: ProviderModel[] = []
      let cursor: string | undefined
      do {
        const result = await this.host.units['runtime'].appServerRequest(host, 'model/list', {
          includeHidden: false,
          limit: 100,
          ...(cursor ? { cursor } : {})
        })
        const data = result['data']
        if (!Array.isArray(data)) {
          throw new Error('Codex model discovery returned an invalid response')
        }
        for (const value of data) {
          const model = mapCodexModel(value, windows)
          if (model) discovered.push(model)
        }
        cursor = stringValue(result['nextCursor'])
      } while (cursor)
      return [...new Map(discovered.map((model) => [model.id, model])).values()]
    } finally {
      if (temporaryHost) {
        this.host.units['runtime'].stopAppServerHost(
          temporaryHost,
          'Codex model discovery completed'
        )
      }
    }
  }

  async retryWithoutReasoningSummary(active: CodexAppServerTurn): Promise<void> {
    const startParams = active.startParams
    if (!startParams) {
      await this.host.units['runtime'].completeAppServerTurn(
        active,
        active.failure ?? 'Codex turn failed'
      )
      return
    }
    active.summaryFallbackAttempted = true
    active.failure = undefined
    const model = stringValue(startParams['model'])
    if (model) this.host.modelsWithoutReasoningSummaries.add(model)
    const clientUserMessageId = stringValue(startParams['clientUserMessageId'])
    try {
      const result = await this.host.units['runtime'].appServerRequest(active.host, 'turn/start', {
        ...startParams,
        ...(clientUserMessageId
          ? { clientUserMessageId: `${clientUserMessageId}:summary-fallback` }
          : {}),
        summary: 'none'
      })
      const turn = recordValue(result['turn'])
      const turnId = stringValue(turn?.['id'])
      if (!turnId) throw new Error('Codex app-server did not return an active fallback turn ID')
      active.turnId = turnId
    } catch (error) {
      await this.host.units['runtime'].completeAppServerTurn(
        active,
        error instanceof Error ? error.message : 'Codex fallback turn could not start'
      )
    }
  }

  /**
   * Separate the summary parts Codex streams for one reasoning item.
   *
   * Codex announces a new summary part with `item/reasoning/summaryPartAdded`
   * instead of delimiting its delta stream. Without a separator between parts
   * the streamed summary ran together (`**First****Second**`), so the live text
   * never matched the completed item's newline-joined summary. Emit the same
   * newline the snapshot uses, and only between parts: the first part opens the
   * summary and needs no leading break.
   */
  emitReasoningSummarySeparator(active: CodexAppServerTurn, params: Record<string, unknown>): void {
    const itemId = stringValue(params['itemId'])
    const summaryIndex = numberValue(params['summaryIndex'])
    if (!itemId || !summaryIndex) return
    const messageId = `${active.session.id}:${itemId}`
    const event: AgentEvent = {
      type: 'message.part.delta',
      sessionId: active.session.id,
      messageId,
      partId: `${messageId}:reasoning`,
      field: 'summary',
      delta: '\n'
    }
    this.host.base.applyEventToSession(active.session, event)
    this.host.base.emit(event)
  }
}
