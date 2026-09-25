import { Logger } from '../../system/logger'
import type {
  CliLineParseContext,
  CliLineParseResult,
  CliTurnCommand,
  PersistentCliSession
} from './persistent-cli-types'

/**
 * Reads newline-delimited JSON from a harness process, tolerating progress
 * redraws and recovering a bracketed object from noisy lines.
 */
export class PersistentCliLineReader {
  constructor(
    private readonly id: string,
    private readonly parse: (
      value: unknown,
      context: CliLineParseContext
    ) => CliLineParseResult | null,
    private readonly apply: (result: CliLineParseResult, session: PersistentCliSession) => void
  ) {}

  consumeLines(
    buffer: string,
    session: PersistentCliSession,
    projectPath: string,
    invocation: CliTurnCommand
  ): string {
    const lines = buffer.split(/\r?\n/u)
    const remainder = lines.pop() ?? ''
    for (const line of lines) this.consumeLine(line, session, projectPath, invocation)
    return remainder
  }

  consumeLine(
    line: string,
    session: PersistentCliSession,
    projectPath: string,
    invocation: CliTurnCommand
  ): void {
    // Some CLIs interleave a progress redraw (`\r`) on the same line as a real
    // event. Normalize the raw line, then fall back to extracting the bracketed
    // JSON object so a genuine event is never dropped because of that noise.
    const normalized = line.replace(/^\r+|\s+$/gu, '')
    if (!normalized) return
    let value: unknown
    try {
      value = JSON.parse(normalized) as unknown
    } catch {
      const recovered = recoverJsonValue(normalized)
      if (recovered === null) {
        Logger.dev(`${this.id} emitted a non-JSONL stdout line`, normalized.slice(0, 400))
        return
      }
      value = recovered
    }
    invocation.onJsonRecord?.(value)
    this.consumeValue(value, session, projectPath)
  }

  /** Consume a provider JSON record from stderr without treating normal stderr as JSONL noise. */
  consumeLineIfPresent(
    line: string,
    session: PersistentCliSession,
    projectPath: string,
    invocation: CliTurnCommand
  ): void {
    const normalized = line.replace(/^\r+|\s+$/gu, '')
    if (!normalized) return
    let value: unknown
    try {
      value = JSON.parse(normalized) as unknown
    } catch {
      return
    }
    invocation.onJsonRecord?.(value)
    this.consumeValue(value, session, projectPath)
  }

  consumeValue(value: unknown, session: PersistentCliSession, projectPath: string): void {
    const result = this.parse(value, {
      session,
      sessionId: session.id,
      projectPath
    })
    if (!result) return
    if (result.nativeSessionId) session.nativeSessionId = result.nativeSessionId
    this.apply(result, session)
  }
}

/**
 * Recover a JSON value from a line that mixes non-JSON noise with a single
 * `{...}` object (e.g. `\rProgress… {"event":"…"}`). Only lines whose prefix
 * before the first `{` and suffix after the last `}` contain no braces are
 * treated as recoverable, so a genuinely malformed JSON line is still dropped.
 */
export function recoverJsonValue(line: string): unknown | null {
  const start = line.indexOf('{')
  const end = line.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  const prefix = line.slice(0, start)
  const suffix = line.slice(end + 1)
  if (prefix.includes('{') || suffix.includes('}')) return null
  try {
    return JSON.parse(line.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
}
