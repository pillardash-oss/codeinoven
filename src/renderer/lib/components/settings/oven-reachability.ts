import type { OvenEndpointAttempt, OvenEndpointProbe } from '$shared/ovens'

/** One line the registration card can print about reaching the machine. */
export interface OvenReachability {
  /** True only when a socket actually answered. */
  reachable: boolean
  /** Success styling belongs to a proven endpoint, never to a decoded code fact. */
  tone: 'success' | 'warning'
  text: string
}

/** Most actionable reason first: an answered machine's closed port beats a dead address. */
const REASON_ORDER = ['refused', 'blocked', 'unreachable', 'timeout', 'unresolved'] as const

/**
 * Turn a probe into the one sentence a person can act on.
 *
 * The probe knows two different failures that the old boolean folded into
 * "nothing is serving SSH": a machine this computer cannot reach at all, and a
 * machine that answers but has no SSH server on the port. They send the user to
 * opposite fixes, so the sentence names the reason instead of the verdict alone.
 */
export function reachabilityOf(probe: OvenEndpointProbe): OvenReachability {
  if (probe.endpoint) {
    const { host, port } = probe.endpoint
    return {
      reachable: true,
      tone: 'success',
      text: `SSH answered on ${host}:${port}, so that is where the Oven will connect.`
    }
  }
  const attempt = worstAttempt(probe.attempts)
  if (!attempt) {
    return {
      reachable: false,
      tone: 'warning',
      text: 'This code lists no address to dial, so enter the address this computer reaches the machine on.'
    }
  }
  return { reachable: false, tone: 'warning', text: explain(attempt) }
}

function worstAttempt(attempts: readonly OvenEndpointAttempt[]): OvenEndpointAttempt | undefined {
  for (const reason of REASON_ORDER) {
    const found = attempts.find((attempt) => attempt.outcome === reason)
    if (found) return found
  }
  return attempts[0]
}

function explain(attempt: OvenEndpointAttempt): string {
  const target = `${attempt.host}:${attempt.port}`
  switch (attempt.outcome) {
    case 'refused':
      return `${attempt.host} answered but refused port ${attempt.port}, so nothing is listening there. Check that the machine's SSH server is running on that port.`
    case 'blocked':
      return `This computer was not allowed to open a connection to ${target}. Check the firewall on this computer.`
    case 'unreachable':
      return `This computer got no answer from ${target}. The machine is off, off this network, or a firewall is dropping the connection.`
    case 'timeout':
      return `${target} did not answer in time. The machine is off, off this network, or a firewall is dropping the connection.`
    case 'unresolved':
      return `${attempt.host} does not resolve from this computer. Enter the address it is reached on instead of its name.`
    default:
      return `This computer could not reach ${target}.`
  }
}
