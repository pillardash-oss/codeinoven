/**
 * Process entry point for a Pi session host.
 *
 * Phase 2 of the resource optimization workstream (see
 * `.cio/work/pi-session-host/plan.md`) launches this inside a utility process
 * and speaks the protocol in `protocol.ts` over its stdio. Until then the test
 * at `tests/main/drivers/pi-session-host.test.ts` exercises the same loop with
 * in-memory streams.
 *
 * The host disposes every session when its input closes or it is signalled.
 */
import { runSessionHost } from './run'

const runtime = runSessionHost(process.stdin, process.stdout)

let closing = false
function shutdown(): void {
  if (closing) return
  closing = true
  runtime.host.dispose()
  runtime.stop()
  process.exit(0)
}

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
