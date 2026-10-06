import { connect } from 'node:net'

/** Short enough that a handful of dead candidates never feels like a hang. */
const CONNECT_TIMEOUT_MS = 1_200
/** A machine reports a bounded list; this is a guard, not a policy. */
const MAX_CANDIDATES = 16

/**
 * Pick the address this computer can actually reach.
 *
 * A machine knows its own addresses but not which of them another computer can
 * reach, so the registration code carries a list. This dials them all at once
 * and returns the first that answers, keeping the machine's own priority order
 * among the ones that do. A candidate that times out or is refused is simply not
 * the answer, never an error the user has to see.
 */
export async function firstReachableAddress(
  addresses: readonly string[],
  port: number
): Promise<string | null> {
  const candidates = [...new Set(addresses.map((entry) => entry.trim()).filter(Boolean))].slice(
    0,
    MAX_CANDIDATES
  )
  if (candidates.length === 0) return null
  const attempts = await Promise.all(
    candidates.map(async (address, index) => ({
      index,
      reachable: await canConnect(address, port)
    }))
  )
  const first = attempts
    .filter((attempt) => attempt.reachable)
    .sort((left, right) => left.index - right.index)[0]
  return first ? (candidates[first.index] ?? null) : null
}

/** Whether a TCP connection to one candidate completes before the timeout. */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (reachable: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}
