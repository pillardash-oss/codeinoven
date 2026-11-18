/**
 * Moving a live session from one host to another.
 *
 * A session is not the process that runs it. Pi keeps everything that matters in
 * the session's own transcript (`sessionFile`, written under the account's agent
 * dir), so a session can be handed from a host that is full, from a host that is
 * shutting down, or from this laptop to an oven, and continued by another host
 * that simply resumes the same transcript. That is the whole mechanism: read the
 * source host's state, resume the transcript on the target host, and make sure
 * exactly one host owns the session at any moment.
 *
 * A sub-agent session is a session like any other. It carries the parent it
 * belongs to so the target host can keep the family intact instead of adopting an
 * orphan.
 */
import type { HostRequestEnvelope, HostSessionState } from '../drivers/pi/session-host/protocol'

/** Everything a target host needs to continue a session it did not create. */
export interface TransferableSession {
  /** The app's session key, stable across hosts. */
  sessionId: string
  /** Working directory the session belongs to; it selects the session dir. */
  cwd: string
  /** The account's Pi agent directory, which is also where the transcript lives. */
  agentDir: string
  /** The transcript to resume. */
  sessionPath: string
  /** Extension modules the session was running with. */
  extensionPaths?: string[]
  /** Tool allowlist the session was running with. */
  tools?: string[]
  /** The model the session was on, so the move does not silently switch it. */
  model?: { provider: string; id: string }
  /** Set for a sub-agent session: the session that spawned it. */
  parentSessionId?: string
}

/** Where a session currently runs, and what is needed to move it. */
export interface SessionLocation {
  hostId: string
  session: TransferableSession
}

/** A session with no transcript has nothing to resume, so it cannot move. */
export function canTransfer(state: HostSessionState | null | undefined): boolean {
  if (!state) return false
  return typeof state.sessionFile === 'string' && state.sessionFile.length > 0
}

/**
 * The request that resumes a session on the target host.
 *
 * It is a `create_session` because resuming is creating a session over an
 * existing transcript: the host loads the file, and the native session id comes
 * from the file rather than from the app.
 */
export function resumeRequest(
  session: TransferableSession,
  requestId: string
): HostRequestEnvelope {
  return {
    type: 'request',
    id: requestId,
    sessionId: session.sessionId,
    command: {
      type: 'create_session',
      cwd: session.cwd,
      agentDir: session.agentDir,
      sessionPath: session.sessionPath,
      ...(session.extensionPaths === undefined ? {} : { extensionPaths: session.extensionPaths }),
      ...(session.tools === undefined ? {} : { tools: session.tools }),
      ...(session.model === undefined ? {} : { model: session.model }),
      // A moved sub-agent keeps its parent, so the target host does not adopt an
      // orphan and the app can still walk the family.
      ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId })
    }
  }
}

/** Build a session location from a host's state, for moving it. */
export function locationFromState(
  hostId: string,
  state: HostSessionState,
  parentSessionId?: string
): SessionLocation {
  if (!canTransfer(state)) {
    throw new Error(`Session ${state.sessionId} has no transcript to move`)
  }
  return {
    hostId,
    session: {
      sessionId: state.sessionId,
      cwd: state.cwd,
      agentDir: state.agentDir,
      sessionPath: String(state.sessionFile),
      ...(parentSessionId === undefined ? {} : { parentSessionId })
    }
  }
}

/**
 * One owner per session.
 *
 * A move is two steps that must not overlap: the source releases the session and
 * the target claims it. Claiming an owned session fails loudly instead of letting
 * two hosts run the same transcript and interleave writes into one file.
 */
export class SessionOwnership {
  #owners = new Map<string, string>()

  owner(sessionId: string): string | null {
    return this.#owners.get(sessionId) ?? null
  }

  /** Take a session for a host. Throws when another host already has it. */
  claim(sessionId: string, hostId: string): void {
    const owner = this.#owners.get(sessionId)
    if (owner === hostId) return
    if (owner !== undefined) {
      throw new Error(`Session ${sessionId} is already running on ${owner}`)
    }
    this.#owners.set(sessionId, hostId)
  }

  /** Give a session back, but only from the host that owns it. */
  release(sessionId: string, hostId: string): void {
    const owner = this.#owners.get(sessionId)
    if (owner !== hostId) {
      throw new Error(
        `Session ${sessionId} cannot be released by ${hostId}: owned by ${owner ?? 'nobody'}`
      )
    }
    this.#owners.delete(sessionId)
  }

  /** Every session a host owns, so a draining host can be emptied on purpose. */
  ownedBy(hostId: string): string[] {
    const owned: string[] = []
    for (const [sessionId, owner] of this.#owners) {
      if (owner === hostId) owned.push(sessionId)
    }
    return owned
  }
}
