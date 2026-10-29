import { Logger } from '../../system/logger'
import {
  codexComputerUseAgeMs,
  peekCodexComputerUse,
  refreshCodexComputerUse,
  type CodexComputerUseReadiness
} from '../codex/codex-computer-use'
import { CodexDriver } from '../codex-driver'

/** CodexDriver panels: one concern, moved verbatim from the composition root. */
export class CodexDriverPanels {
  constructor(
    private readonly host: CodexDriver,
    private readonly base: CodexDriver['base']
  ) {}

  /**
   * Codex's own computer-use availability, from the process-wide cache.
   *
   * The answer is a device fact, so it is shared by every driver instance and
   * every turn. A turn that already has an answer gets it immediately and the
   * device is re-measured in the background; only the first turn of a process
   * pays for a Codex launch, and that launch is not on the path to the first
   * token of any later turn.
   */
  async codexComputerUse(): Promise<CodexComputerUseReadiness> {
    const key = this.host.codexHomeKey()
    const cached = peekCodexComputerUse(key)
    if (cached) {
      const age = codexComputerUseAgeMs(key) ?? 0
      if (age > CodexDriver.COMPUTER_USE_STALE_MS) void this.host.refreshComputerUse(key)
      this.noteComputerUse(cached)
      return cached
    }
    return this.host.refreshComputerUse(key)
  }

  refreshComputerUse(key: string): Promise<CodexComputerUseReadiness> {
    return refreshCodexComputerUse(key, {
      env: { ...process.env, ...this.host.accountEnvironment }
    }).then((value) => {
      this.noteComputerUse(value)
      return value
    })
  }

  /** Report the device answer once per driver, so a support report can read it. */
  noteComputerUse(readiness: CodexComputerUseReadiness): void {
    if (this.host.computerUseLogged !== readiness.available) {
      this.host.computerUseLogged = readiness.available
      Logger.info(
        `Codex computer use ${readiness.available ? 'enabled' : 'unavailable'}: ${readiness.reason}`
      )
    }
  }

  /** `-c` pairs that turn Codex's own computer use on for one launch. */
  async computerUseConfigArgs(): Promise<string[]> {
    const readiness = await this.codexComputerUse()
    return readiness.configOverrides.flatMap((override) => ['-c', override])
  }
}
