import { isGloballyRoutableAddress } from './addresses'

/**
 * Ask an echo service what address the rest of the internet sees this machine on.
 *
 * A machine behind NAT cannot see the address others reach it on: the public
 * address belongs to the router, the load balancer, or the cloud provider's
 * edge, and nothing in the local interface list mentions it. So the descriptor
 * could otherwise only offer private addresses, which the app dials in order
 * and every one of them times out on a workstation that is not on that private
 * network.
 *
 * An echo service answers with the source address it observed, which is exactly
 * the address another machine outside this network would dial. That candidate is
 * worth trying first, so the app gets a working connection without the operator
 * typing anything. It is a hint, not a fact: it is only offered first, and the
 * app still falls back to the rest of the list when it does not answer.
 *
 * The lookup is best-effort and never throws. A machine with no route out, a
 * blocking proxy, or a service that answers garbage only costs one bounded
 * timeout, and startup continues with the machine's own addresses.
 */

/** The echo services asked in order, each answering with one bare address. */
const DEFAULT_ENDPOINTS: readonly string[] = [
  'https://api.ipify.org',
  'https://ifconfig.me/ip',
  'https://icanhazip.com'
]

/** How long one endpoint gets before the next is tried. */
const DEFAULT_TIMEOUT_MS = 1500

export interface DiscoverPublicAddressOptions {
  /** The fetch to use. Tests pass a stub so no real network call is made. */
  fetchImpl?: typeof fetch
  /** How long one endpoint gets before the next is tried, in milliseconds. */
  timeoutMs?: number
  /** The echo services to try, in order. */
  endpoints?: readonly string[]
}

/**
 * This machine's public address, or `undefined` when no service could say.
 *
 * Endpoints are tried in order and the first accepted answer wins. A failed
 * request, a non-200 response, a body that is not an IP address, or an address
 * that cannot be reached from another machine all move on to the next endpoint.
 */
export async function discoverPublicAddress(
  options: DiscoverPublicAddressOptions = {}
): Promise<string | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const endpoints = options.endpoints ?? DEFAULT_ENDPOINTS
  for (const endpoint of endpoints) {
    const address = await askEchoService(endpoint, fetchImpl, timeoutMs)
    if (address !== undefined) return address
  }
  return undefined
}

/**
 * The public address one echo service reports, or `undefined` when it cannot say.
 *
 * The body must be one bare address: anything longer, such as a block page or a
 * JSON envelope, is a proxy answering rather than the service, and an address
 * that is not routable is the network the request left from rather than the
 * address another machine would dial.
 */
async function askEchoService(
  endpoint: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(endpoint, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'text/plain' }
    })
    if (!response.ok) return undefined
    const answer = (await response.text()).trim()
    return isGloballyRoutableAddress(answer) ? answer : undefined
  } catch {
    /* Offline, blocked, timed out, or refused: try the next endpoint. */
    return undefined
  }
}
