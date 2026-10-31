import { type CodexServerRequest } from '../codex/codex-protocol'
import type { CodexDriver } from '../codex-driver'

/** CodexDriver protocol: one concern, moved verbatim from the composition root. */
export class CodexDriverProtocol {
  constructor(
    private readonly host: CodexDriver,
    private readonly base: CodexDriver['base']
  ) {}

  writeServerResponse(request: CodexServerRequest, result: Record<string, unknown>): void {
    request.host.child.stdin?.write(`${JSON.stringify({ id: request.id, result })}\n`)
  }
}
