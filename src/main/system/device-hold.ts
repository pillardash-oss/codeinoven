/**
 * The device gate for a turn that is about to start.
 *
 * The window already parks a message when the machine is short, but the window
 * is not the only way a turn begins: the assistant API, dictation, Don's panel
 * and the design coordinator each reach a thread without a composer. A device
 * policy only the composer honours is not a policy, so main answers the same
 * question at the entry every user turn passes through, and refuses to start
 * work the machine cannot afford right now.
 *
 * The refusal is a typed error rather than a silent drop: the caller keeps the
 * message and the reason, and the turn starts as soon as the device has room.
 */
import { holdsAdmission, type AdmissionDecision } from '../../lib/resource-admission'
import { Logger } from './logger'
import { resourcePressure } from './resource-pressure'

/** A user turn that may not start yet, carrying the reading that held it. */
export class DeviceHoldError extends Error {
  readonly decision: AdmissionDecision

  constructor(decision: AdmissionDecision) {
    // The window parks a message on its own reading before it ever gets here, so
    // reaching this refusal means the machine turned short between the two
    // readings. Nothing is queued by this path, so the message must not promise
    // that the turn is waiting: it says where the words are and what to do.
    super(
      'The device is short on CPU and memory. The message is kept; send it again once the machine has room.'
    )
    this.name = 'DeviceHoldError'
    this.decision = decision
  }
}

/**
 * The reading that holds a new turn, or null when it may start.
 *
 * A reading that cannot be taken fails open: an unreachable sampler must never
 * stop the user's work.
 */
export async function deviceHoldForNewTurn(): Promise<DeviceHoldError | null> {
  try {
    const decision = await resourcePressure.read()
    return holdsAdmission(decision) ? new DeviceHoldError(decision) : null
  } catch (error) {
    Logger.dev('Device gate: admission reading failed', error)
    return null
  }
}
