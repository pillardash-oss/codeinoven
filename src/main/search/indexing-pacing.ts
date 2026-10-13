import { setTimeout as delay } from 'node:timers/promises'

/** Background work gets a small duty cycle; completion speed is secondary. */
export async function paceIndexing(startedAt: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const workMs = Math.max(0, performance.now() - startedAt)
  await delay(Math.min(600_000, Math.max(30_000, workMs * 99)), undefined, { signal })
}
