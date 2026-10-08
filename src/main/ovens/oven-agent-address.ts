import { connect } from 'node:net'

/** Short enough that a handful of dead candidates never feels like a hang. */
const CONNECT_TIMEOUT_MS = 1_200
/** A machine reports a bounded list; this is a guard, not a policy. */
const MAX_ADDRESSES = 16
/** The ports worth dialling when the machine's own report cannot be trusted. */
const MAX_PORTS = 3

/**
 * Where this computer reaches an Oven: the pair that actually answered.
 *
 * The port matters as much as the address. A registration code carries the port
 * the machine believed its SSH server was on, and that belief is a prompt answer
 * the machine cannot verify from the outside: a mistyped or copied-over port is
 * saved as truth and every later connection times out on a socket nothing is
 * listening on.
 */
export interface OvenEndpoint {
  host: string
  port: number
}

/**
 * Pick the address and port this computer can actually reach.
 *
 * A machine knows its own addresses but not which of them another computer can
 * reach, nor whether the port it was told is the one `sshd` answers on, so the
 * registration code carries a list of addresses and this probes them. The
 * machine's own port is tried first because it is the more specific claim; the
 * remaining ports catch a wrong answer without making the user find it.
 *
 * Address order decides before port order: a machine's first reachable address
 * is its own preferred one, and one address answering on a fallback port is
 * still more trustworthy than a later address answering on the reported one.
 * A candidate that times out or is refused is simply not the answer, never an
 * error the user has to see.
 */
export async function firstReachableEndpoint(
  addresses: readonly string[],
  ports: readonly number[]
): Promise<OvenEndpoint | null> {
  const candidates = [...new Set(addresses.map((entry) => entry.trim()).filter(Boolean))].slice(
    0,
    MAX_ADDRESSES
  )
  const dialable = [...new Set(ports.filter(isDialablePort))].slice(0, MAX_PORTS)
  if (candidates.length === 0 || dialable.length === 0) return null

  const attempts = await Promise.all(
    candidates.flatMap((host, addressIndex) =>
      dialable.map(async (port, portIndex) => ({
        addressIndex,
        portIndex,
        endpoint: { host, port },
        reachable: await canConnect(host, port)
      }))
    )
  )
  const first = attempts
    .filter((attempt) => attempt.reachable)
    .sort(
      (left, right) => left.addressIndex - right.addressIndex || left.portIndex - right.portIndex
    )[0]
  return first?.endpoint ?? null
}

function isDialablePort(port: number): boolean {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535
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
    // The idle timeout is a timer, and libuv runs timers before poll. A busy
    // event loop that outlasts CONNECT_TIMEOUT_MS therefore reports the timeout
    // ahead of a `connect` whose handshake the kernel already completed, and
    // destroying the socket then makes an address that answers look dead. Give
    // the verdict one loop turn so the pending `connect` or `error` in the poll
    // phase is delivered first; only a socket still open after that is a real
    // timeout.
    socket.once('timeout', () => setImmediate(() => finish(false)))
    socket.once('error', () => finish(false))
  })
}
