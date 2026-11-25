import { isIP } from 'node:net'
import { networkInterfaces, hostname, type NetworkInterfaceInfo } from 'node:os'

/** One entry of `os.networkInterfaces()` flattened to what ranking needs. */
export interface AddressCandidate {
  address: string
  family: string
  internal: boolean
}

/**
 * Every address this machine answers on, most likely to be reachable first.
 *
 * A machine cannot know which of its own addresses another computer can reach:
 * that depends on the network between them, not on this machine. So rather than
 * guess one, the agent reports all of its real candidates and the app dials them
 * and keeps the first that connects.
 *
 * The order is a head start, not a decision. A discovered public address leads,
 * because it is the one answer that came from outside this machine and was
 * checked to be routable. The interface addresses follow: private LAN ranges
 * first, because that is the shape of a development machine reached from a
 * workstation, then anything else routable, then the host name last: it is the
 * value that fails most often, and it is only useful when mDNS or DNS actually
 * resolves it.
 */
export function candidateAddresses(publicAddress?: string): string[] {
  return rankAddresses(flattenInterfaces(networkInterfaces()), hostname(), publicAddress)
}

/** Flatten the platform's interface map into one list of candidates. */
function flattenInterfaces(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): AddressCandidate[] {
  const candidates: AddressCandidate[] = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      candidates.push({ address: entry.address, family: entry.family, internal: entry.internal })
    }
  }
  return candidates
}

/**
 * Order candidates for dialing, dropping the ones that can never help.
 *
 * A supplied public address leads, deduped against the rest, because a machine
 * behind NAT never sees that address among its own interfaces and it is the one
 * candidate the app can dial from outside the network it sits in.
 *
 * Pure on purpose: the app's own tests pin the ordering rules here rather than
 * depending on whatever interfaces the machine running them happens to have.
 */
export function rankAddresses(
  candidates: readonly AddressCandidate[],
  hostName: string,
  publicAddress?: string
): string[] {
  const ipv4Private: string[] = []
  const ipv4Other: string[] = []
  const ipv6: string[] = []
  for (const candidate of candidates) {
    if (candidate.internal) continue
    // A zone index (`%en0`) is meaningful only to this machine's stack.
    const address = candidate.address.split('%')[0]
    if (!address) continue
    if (candidate.family === 'IPv4') {
      if (isPrivateIpv4(address)) ipv4Private.push(address)
      else ipv4Other.push(address)
    } else if (candidate.family === 'IPv6' && isGlobalIpv6(address)) {
      ipv6.push(address)
    }
  }
  const lead = publicAddress?.trim()
  return [...new Set([...(lead ? [lead] : []), ...ipv4Private, ...ipv4Other, ...ipv6, hostName])]
}

/**
 * Whether an address could name this machine to another one across the internet.
 *
 * An echo service answers with whatever address it saw the request arrive from,
 * which is not always useful: a caching proxy, a loopback listener, or a
 * service reached over a private network can all report an address that no
 * other machine can dial. Only a routable address is worth offering first.
 *
 * Rejects what cannot leave this machine or its network: loopback, the RFC 1918
 * ranges and carrier-grade NAT, link-local, multicast and reserved space, and
 * the IPv6 forms of the same (loopback, link-local, unique-local, and IPv4-mapped
 * private addresses). Anything `node:net` does not parse as an IP is rejected
 * too, so a proxy's HTML block page is never mistaken for an address.
 */
export function isGloballyRoutableAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isRoutableIpv4(address)
  if (family !== 6) return false
  // `::ffff:10.0.0.5` is the IPv4 address in IPv6 clothing; judge the IPv4 one.
  const mapped = ipv4MappedAddress(address)
  if (mapped !== undefined) return isIP(mapped) === 4 && isRoutableIpv4(mapped)
  return isGlobalIpv6(address)
}

/** The IPv4 address carried inside an IPv4-mapped IPv6 address, when it is one. */
function ipv4MappedAddress(address: string): string | undefined {
  return /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address)?.[1]
}

/** Whether an IPv4 address names a host some other machine could reach. */
function isRoutableIpv4(address: string): boolean {
  const [first, second] = address.split('.').map(Number)
  // 0.0.0.0/8 is "this network" and 127.0.0.0/8 is loopback: neither leaves the host.
  if (first === 0 || first === 127) return false
  // 224.0.0.0/4 is multicast and 240.0.0.0/4 is reserved: nothing answers there.
  if (first >= 224) return false
  // 169.254.0.0/16 is link-local, which names a link rather than a host.
  if (first === 169 && second === 254) return false
  return !isPrivateIpv4(address)
}

/** RFC 1918 and carrier-grade NAT, the ranges a workstation can typically reach. */
function isPrivateIpv4(address: string): boolean {
  const [first, second] = address.split('.').map(Number)
  if (first === 10) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first === 100 && second >= 64 && second <= 127) return true
  return false
}

/**
 * Whether an IPv6 address can plausibly name a host on another machine.
 *
 * Only global unicast (`2000::/3`) qualifies. Link-local (`fe80::/10`) names a
 * link and unique-local (`fc00::/7`) names a site, so neither is reachable from
 * a machine outside them and both would only add noise to the candidate list.
 */
function isGlobalIpv6(address: string): boolean {
  const first = Number.parseInt(address.split(':')[0] || '0', 16)
  return first >= 0x2000 && first <= 0x3fff
}
