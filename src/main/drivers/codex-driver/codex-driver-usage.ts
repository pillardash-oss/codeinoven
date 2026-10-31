import { randomUUID } from 'crypto'
import type {
  AgentBankedResets,
  AgentEvent,
  AgentRateLimitWindow,
  AgentUsageCredits
} from '../../../lib/types'
import { Logger } from '../../system/logger'
import type { GenerateTitleOptions } from '../driver.interface'
import { type PersistentCliSession } from '../persistent-cli-driver'
import { type CodexAppServerHost } from '../codex/codex-protocol'
import { mapCodexRateLimits } from '../codex/codex-usage'
import type { CodexDriver } from '../codex-driver'

/** CodexDriver usage: one concern, moved verbatim from the composition root. */
export class CodexDriverUsage {
  constructor(
    private readonly host: CodexDriver,
    private readonly base: CodexDriver['base']
  ) {}

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    return this.host.base.generateTitleWithCandidates(
      projectPath,
      options,
      options.candidates ?? (await this.host.units['title'].cheapestCandidate(projectPath))
    )
  }

  /** Refresh account quota data through Codex's supported app-server surface. */
  async refreshRateLimits(
    projectPath: string,
    session: PersistentCliSession,
    messageId: string
  ): Promise<void> {
    const host = await this.host.units['runtime'].ensureAppServerHost(projectPath)
    const telemetry = mapCodexRateLimits(
      await this.host.units['runtime'].appServerRequest(host, 'account/rateLimits/read')
    )

    if (telemetry.rateLimits.length === 0 && !telemetry.credits && !telemetry.bankedResets) return
    const event: AgentEvent = {
      type: 'usage.updated',
      sessionId: session.id,
      messageId,
      ...(telemetry.rateLimits.length > 0 ? { rateLimits: telemetry.rateLimits } : {}),
      ...(telemetry.credits ? { credits: telemetry.credits } : {}),
      ...(telemetry.bankedResets ? { bankedResets: telemetry.bankedResets } : {})
    }
    this.host.base.applyEventToSession(session, event)
    this.host.base.emit(event)
    await this.host.base.persistSession(session)
  }

  /**
   * Fetch current quota telemetry through the resident app-server, including
   * for old threads whose turns predate quota capture.
   */
  async readAccountUsage(projectPath: string): Promise<{
    rateLimits: AgentRateLimitWindow[]
    credits?: AgentUsageCredits
    bankedResets?: AgentBankedResets
    reauthenticationRequired?: boolean
  } | null> {
    let temporaryHost: CodexAppServerHost | null = null
    try {
      const host =
        this.host.hostsByProjectPath.has(projectPath) ||
        this.host.hostsStartingByProjectPath.has(projectPath)
          ? await this.host.units['runtime'].ensureAppServerHost(projectPath)
          : (temporaryHost = await this.host.units['runtime'].createAppServerHost(projectPath))
      const telemetry = mapCodexRateLimits(
        await this.host.units['runtime'].appServerRequest(host, 'account/rateLimits/read')
      )
      if (telemetry.rateLimits.length === 0 && !telemetry.credits && !telemetry.bankedResets) {
        return null
      }
      return telemetry
    } catch (error) {
      Logger.dev('Codex on-demand account usage refresh unavailable:', error)
      if (
        error instanceof Error &&
        /401 Unauthorized[\s\S]*token_expired|token_expired[\s\S]*401 Unauthorized/iu.test(
          error.message
        )
      ) {
        return { rateLimits: [], reauthenticationRequired: true }
      }
      return null
    } finally {
      if (temporaryHost) {
        this.host.units['runtime'].stopAppServerHost(
          temporaryHost,
          'Codex account usage probe completed'
        )
      }
    }
  }

  /**
   * Redeem one banked rate-limit reset credit. Destructive and irreversible:
   * it immediately resets the account's active 5-hour and weekly usage
   * windows and consumes one banked credit. The caller is responsible for
   * confirming with the user before invoking this.
   */
  async activateBankedReset(projectPath: string): Promise<{
    rateLimits: AgentRateLimitWindow[]
    credits?: AgentUsageCredits
    bankedResets?: AgentBankedResets
  } | null> {
    let temporaryHost: CodexAppServerHost | null = null
    try {
      const host =
        this.host.hostsByProjectPath.has(projectPath) ||
        this.host.hostsStartingByProjectPath.has(projectPath)
          ? await this.host.units['runtime'].ensureAppServerHost(projectPath)
          : (temporaryHost = await this.host.units['runtime'].createAppServerHost(projectPath))
      const usage = mapCodexRateLimits(
        await this.host.units['runtime'].appServerRequest(host, 'account/rateLimits/read')
      )
      const now = Date.now()
      let selectedCredit: NonNullable<AgentBankedResets['credits']>[number] | undefined
      for (const credit of usage.bankedResets?.credits ?? []) {
        if (typeof credit.expiresAt === 'number' && credit.expiresAt <= now) continue
        if (
          !selectedCredit ||
          (credit.expiresAt ?? Infinity) < (selectedCredit.expiresAt ?? Infinity)
        ) {
          selectedCredit = credit
        }
      }
      // Prefer the earliest known expiry. Count-only responses from older
      // app-server versions still use the provider's default selection.
      await this.host.units['runtime'].appServerRequest(
        host,
        'account/rateLimitResetCredit/consume',
        {
          idempotencyKey: randomUUID(),
          ...(selectedCredit ? { creditId: selectedCredit.id } : {})
        }
      )
      return mapCodexRateLimits(
        await this.host.units['runtime'].appServerRequest(host, 'account/rateLimits/read')
      )
    } finally {
      if (temporaryHost) {
        this.host.units['runtime'].stopAppServerHost(
          temporaryHost,
          'Codex banked reset activation completed'
        )
      }
    }
  }
}
