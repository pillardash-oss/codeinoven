/**
 * The device reading that decides whether a send may leave right now.
 *
 * The gate sits between the click and the message appearing, so it has to be
 * cheap: this module answers a send from the reading it already holds when that
 * reading is recent, and asks the main process only when it has nothing to
 * answer with. A reading a few seconds old is the same answer, because the
 * device sampler averages its own samples over five seconds.
 *
 * A read that FAILED is never remembered. A null answer means "may send", so
 * caching an outage as permission is not the same thing as the gate having said
 * the machine has room: the next send asks again.
 *
 * The caches are plain module state, not reactive state, which is why this lives
 * beside the store rather than inside it: nothing on screen derives from them.
 */
import { invoke } from '$lib/ipc.svelte'
import { DEADLINE_EXCEEDED, withDeadline } from '$shared/with-deadline'
import type { ThreadResourceGateAnswer } from '$shared/resource-admission'

/**
 * How long a gate reading may answer a send.
 *
 * Deliberately shorter than the device sampler's own five sample window: an
 * answer this fresh cannot be older than the reading the gate would take again,
 * and a send that follows typing must not start the round-trip it already has
 * the answer to.
 */
const HOLD_READING_TTL_MS = 8_000

/**
 * How long a gate read may take before the send goes ahead without it.
 *
 * The gate protects the machine, so a slow gate is a reason to skip the gate,
 * never a reason to hold the user's message. This deadline is what makes that
 * true: the read is answered by a database worker or by an SSH probe of another
 * machine, and either can stall indefinitely on a struggling device. Without a
 * bound, one stalled read stayed in `reads` for the life of the window and every
 * later send on that thread awaited the same promise, so the composer accepted
 * clicks and delivered nothing at all while the rest of the UI kept working.
 */
export const HOLD_READING_TIMEOUT_MS = 3_000

/** One finished gate read: the answer, where null inside means "may send". */
interface GateReading {
  answer: ThreadResourceGateAnswer | null
}

/** The last gate answer per thread, so a send answers from memory when it can. */
const readings = new Map<string, { answer: ThreadResourceGateAnswer | null; at: number }>()

/** Reads in flight, so two sends in the same tick ask the gate once. */
const reads = new Map<string, Promise<GateReading | null>>()

/**
 * The reading that should hold a new turn on this thread, or null when the
 * turn may start. The gate answers for whichever machine will run it: this
 * device for a local thread, the named Oven for an Oven thread. A reading that
 * cannot be taken fails open: an unreachable sampler must never stop the
 * user's work.
 */
export async function readThreadHold(
  projectId: string,
  threadId: string
): Promise<ThreadResourceGateAnswer | null> {
  const key = gateKey(projectId, threadId)
  const cached = readings.get(key)
  if (cached !== undefined && Date.now() - cached.at < HOLD_READING_TTL_MS) return cached.answer
  const inFlight = reads.get(key)
  if (inFlight) return (await inFlight)?.answer ?? null
  return await askThreadHold(projectId, threadId)
}

/**
 * Take the gate reading for a thread the reader just opened, so the send that
 * follows finds an answer instead of starting a round-trip.
 *
 * Called off the open path on purpose: the reading protects the device, it is
 * not something a click should wait for, and a send still asks the gate for
 * itself when nothing has read it recently.
 */
export function warmThreadHold(projectId: string, threadId: string): void {
  if (!projectId || !threadId) return
  void readThreadHold(projectId, threadId).catch(() => undefined)
}

/**
 * Ask the gate for one thread and remember the answer, coalescing duplicate
 * asks.
 */
async function askThreadHold(
  projectId: string,
  threadId: string
): Promise<ThreadResourceGateAnswer | null> {
  const key = gateKey(projectId, threadId)
  const pending = (async (): Promise<GateReading | null> => {
    try {
      const answer = await withDeadline(
        invoke('system:threadResourceGate', projectId, threadId),
        HOLD_READING_TIMEOUT_MS
      )
      // A read that ran out of time is not an answer: the send goes ahead, and
      // nothing about it is remembered. Caching a timeout would turn one slow
      // instant into a permanently believed hold.
      if (answer === DEADLINE_EXCEEDED) return null
      // Null means "may send". The gate answers for every thread, so returning
      // the answer itself would read as a hold for a perfectly idle machine, and
      // every send would park instead of leaving: a message that slides up the
      // screen and never arrives.
      return { answer: answer.wait === null ? null : answer }
    } catch {
      return null
    }
  })()
  reads.set(key, pending)
  try {
    const reading = await pending
    if (reading === null) return null
    readings.set(key, { answer: reading.answer, at: Date.now() })
    return reading.answer
  } finally {
    reads.delete(key)
  }
}

function gateKey(projectId: string, threadId: string): string {
  return `${projectId}\u0000${threadId}`
}
