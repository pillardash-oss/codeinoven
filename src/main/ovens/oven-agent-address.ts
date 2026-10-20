import { connect } from 'node:net'
import type {
  OvenEndpoint,
  OvenEndpointAttempt,
  OvenEndpointFailure,
  OvenEndpointProbe
} from '../../lib/ovens'

/** Short enough that a handful of dead candidates never feels like a hang. */
const CONNECT_TIMEOUT_MS = 1_200
/** A machine reports a bounded list; this is a guard, not a policy. */
const MAX_ADDRESSES = 16
/** The ports worth dialling when the machine's own report cannot be trusted. */
const MAX_PORTS = 3

/**
 * Pick the address and port this computer can actually reach, and say what
 * stopped the ones that did not answer.
 *
 * A machine knows its own addresses but not which of them another computer can
 * reach, nor whether the port it was told is the one `sshd` answers on, so the
 * registration code carries a list of addresses and this dials them. The
 * machine's own port is tried first because it is the more specific claim; the
 * remaining ports catch a wrong answer without making the user find it.
 *
 * Address order decides before port order: a machine's first reachable address
 * is its own preferred one, and one address answering on a fallback port is
 * still more trustworthy than a later address answering on the reported one.
 * A candidate that is refused, unreachable or times out is never an error the
 * user has to see, but its reason is kept: it is the difference between a
 * machine that is off and a machine whose `sshd` is not running.
 */
export async function probeEndpoint(
  addresses: readonly string[],
  ports: readonly number[]
): Promise<OvenEndpointProbe> {
  const candidates = [...new Set(addresses.map((entry) => entry.trim()).filter(Boolean))].slice(
    0,
    MAX_ADDRESSES
  )
  const dialable = [...new Set(ports.filter(isDialablePort))].slice(0, MAX_PORTS)
  if (candidates.length === 0 || dialable.length === 0) return { endpoint: null, attempts: [] }

  const attempts = await Promise.all(
    candidates.flatMap((host) => dialable.map((port) => dial(host, port)))
  )
  const answered = attempts.find((attempt) => attempt.outcome === 'answered')
  const endpoint: OvenEndpoint | null = answered
    ? { host: answered.host, port: answered.port }
    : null
  return { endpoint, attempts }
}

function isDialablePort(port: number): boolean {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535
}

/** Dial one candidate and report whether, and why not, it answered. */
function dial(host: string, port: number): Promise<OvenEndpointAttempt> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (outcome: OvenEndpointAttempt['outcome']): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ host, port, outcome })
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS)
    socket.once('connect', () => finish('answered'))
    // The idle timeout is a timer, and libuv runs timers before poll. A busy
    // event loop that outlasts CONNECT_TIMEOUT_MS therefore reports the timeout
    // ahead of a `connect` whose handshake the kernel already completed, and
    // destroying the socket then makes an address that answers look dead. Give
    // the verdict one loop turn so the pending `connect` or `error` in the poll
    // phase is delivered first; only a socket still open after that is a real
    // timeout.
    socket.once('timeout', () => setImmediate(() => finish('timeout')))
    socket.once('error', (cause: NodeJS.ErrnoException) => finish(reasonOf(cause.code)))
  })
}

/**
 * Turn a socket error into the situation it describes.
 *
 * The three cases a user can act on are separated: the name does not resolve
 * here, the machine cannot be reached at all, or the machine answered and
 * refused the port. Anything unrecognised is reported as unreachable rather than
 * as a listener that is missing, because claiming a closed port would send the
 * user to the wrong machine setting.
 */
function reasonOf(code: string | undefined): OvenEndpointFailure {
  switch (code) {
    case 'ECONNREFUSED':
      return 'refused'
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NONAME':
      return 'unresolved'
    case 'EACCES':
    case 'EPERM':
      return 'blocked'
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
    case 'ENETDOWN':
    case 'EADDRNOTAVAIL':
    case 'ETIMEDOUT':
      return 'unreachable'
    default:
      return 'unreachable'
  }
}
