import { buildProcessEnvironment } from '../cli-environment'

/** Claude Code process environment, tool naming, auth gates, and one-shot spawn bound. */

/** How long a successful `claude auth status` pre-flight verdict is trusted. */
export const PRE_FLIGHT_AUTH_PROBE_TTL_MS = 30_000

/** Bounded wait for the `claude auth status` pre-flight probe. */
export const PRE_FLIGHT_AUTH_PROBE_TIMEOUT_MS = 8_000

/**
 * How long a first-party session spawn may hold the credential-refresh gate
 * while it resolves authentication. The gate exists because Claude Code's
 * macOS keychain OAuth store races when two processes refresh a single-use
 * token concurrently (anthropics/claude-code#76905); the loser wipes the
 * shared credential. The gate must stay held until authentication is PROVEN
 * (message_start), not a short timer: a fast cap re-opens the race window
 * whenever the first refresh takes longer than the cap (the CLI retries a
 * failing refresh for ~45s, so a 1.5s cap let concurrent spawns through).
 * This bound is only a safety valve so a pathological CLI cannot stall other
 * threads/projects indefinitely; normal auth confirms in ~1-3s and releases
 * the gate immediately.
 */
export const AUTH_CONFIRM_TIMEOUT_MS = 60_000

/** Poll interval while waiting for a spawned session to prove authentication. */
export const AUTH_CONFIRM_POLL_MS = 200

/**
 * Cap on concurrent one-shot `claude` spawns (auth probe, on-demand usage
 * refresh, version probe, model discovery). Every one-shot spawn holds several
 * file descriptors (stdio pipes) for its lifetime, so a burst of threads or
 * projects refreshing simultaneously can exhaust the process fd table and
 * fail later spawns with `EBADF`. Bounding the one-shots keeps the fd table
 * stable without touching long-lived session processes, which are gated
 * separately by the credential-refresh slot.
 */
export const ONE_SHOT_SPAWN_LIMIT = 4

/** Keep Claude Code's native per-repository memory from crossing app threads. */
export function buildClaudeEnvironment(
  accountEnvironment: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  return {
    ...buildProcessEnvironment({ ...process.env, ...accountEnvironment }),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_ENABLE_TODO_TOOLS: '1'
  }
}

export const CLAUDE_TOOL_NAMES: Record<string, string> = {
  question: 'AskUserQuestion',
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  list: 'Glob',
  lsp: 'LSP',
  bash: 'Bash',
  webfetch: 'WebFetch',
  websearch: 'WebSearch'
}

export function claudeToolName(value: string): string {
  return CLAUDE_TOOL_NAMES[value.toLowerCase()] ?? value
}

/** A tiny FIFO semaphore used to bound concurrent one-shot claude spawns. */
export class OneShotSpawnGate {
  private readonly queue: (() => void)[] = []
  private active = 0

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.queue.shift()?.()
    }
  }
}
