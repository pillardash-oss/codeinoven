import { setTimeout as delay } from 'node:timers/promises'

/** Give other applications three times the time spent on each background item. */
export async function paceIndexing(startedAt: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const workMs = Math.max(0, performance.now() - startedAt)
  await delay(Math.min(30_000, Math.max(250, workMs * 3)), undefined, { signal })
}
