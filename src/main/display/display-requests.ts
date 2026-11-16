import type {
  DisplayAvailability,
  DisplaySourceDescriptor,
  DisplaySourceKind,
  DisplayTargetOffer,
  DisplayThreadActivity
} from '../../lib/ipc/display'
import { displayService } from './display-runtime'

/**
 * What the agent asked the panel to mirror, and which thread asked for it.
 *
 * A request here is what puts a device on screen. Two things make one: the agent
 * calling `ext_simulation` with the device it is working on, and the app reading a
 * device command (`adb`, `emulator`, `simctl`) out of a tool call the thread
 * already ran. The second exists because an agent that goes straight to adb has no
 * reason to look for a mirroring tool first, and the person watching that thread
 * should not have to ask for the picture.
 *
 * Both are event-driven: no watch, no timer and no scan behind them, so an app
 * whose agents are not working on a device costs nothing at all.
 *
 * The store owns only the notification. Resolving a device id to a label and a
 * mark is the display service's own listing, so the panel shows exactly what its
 * picker would, and the tool result tells the agent whether the device it named
 * was really there.
 */

/** Where the renderer is told about a target, bound once at boot. */
export interface DisplayEventSink {
  target: (offer: DisplayTargetOffer) => void
  activity: (activity: DisplayThreadActivity) => void
  available: () => void
}

let sink: DisplayEventSink | null = null

/** Point the store at the window that receives its events. */
export function bindDisplayEventSink(next: DisplayEventSink | null): void {
  sink = next
}

/** What `ext_simulation` asks for: one platform, one device, or a close. */
export interface DisplayRequestInput {
  platform: DisplaySourceKind
  device?: string | undefined
  threadId: string
  /** The project the asking thread lives in, so its mark can be cleared per project. */
  projectId?: string | undefined
}

/** One device the caller could have meant, as the tool result lists it. */
export interface DisplayRequestOption {
  device: string
  label: string
  detail?: string
}

/** The tool's answer, shaped by the schema its definition publishes. */
export interface DisplayRequestResult {
  ok: boolean
  mirrored?: DisplayRequestOption
  available?: DisplayRequestOption[]
  message?: string
}

function optionFor(source: DisplaySourceDescriptor): DisplayRequestOption {
  return {
    device: source.sourceId,
    label: source.label,
    ...(source.detail ? { detail: source.detail } : {})
  }
}

/** Whether a device id the agent typed is the one this entry describes. */
function matchesDevice(source: DisplaySourceDescriptor, device: string): boolean {
  const wanted = device.trim().toLowerCase()
  if (wanted.length === 0) return false
  if (source.sourceId.toLowerCase() === wanted) return true
  // A label match is a courtesy for a model that copied "Pixel 8 · emulator-5554"
  // out of a listing instead of the id alone.
  return source.label.toLowerCase().includes(wanted)
}

/**
 * Which device the caller meant, out of the ones that exist.
 *
 * Pure on purpose: the device list is what the platform answers, and this decides
 * from it alone, so an ambiguous request is refused with the list instead of
 * silently mirroring whatever came first.
 */
export function chooseDisplaySource(
  sources: readonly DisplaySourceDescriptor[],
  device: string | undefined
): DisplaySourceDescriptor | null {
  const wanted = device?.trim()
  if (wanted && wanted.length > 0) {
    return sources.find((source) => matchesDevice(source, wanted)) ?? null
  }
  return sources.length === 1 ? (sources[0] ?? null) : null
}

class DisplayRequests {
  /** When the panel first had something to show, for `display:presence`. */
  private availableSince: number | null = null
  /**
   * Threads that asked to mirror something, so their row wears the mark.
   *
   * The project travels with each one: closing the panel of a project ends the
   * mirror for the threads driving devices in that project, and nothing else. A
   * thread in another project keeps its mark, which is the whole point of the
   * mark being about the work rather than about the panel being open.
   */
  private readonly threads = new Map<string, { at: number; projectId: string }>()
  /**
   * The thread whose own display tab is on screen, when no agent asked for it.
   *
   * A person can open the panel and pick a device, and the thread they are
   * standing in is what that mirror belongs to. It is held apart from the asking
   * threads so closing the panel never erases a mark an agent put there.
   */
  private panelThread: { threadId: string; projectId: string } | null = null
  /** The target on screen, as `kind:sourceId`, so a repeat is not a reopen. */
  private mirrored: string | null = null

  state(): DisplayAvailability {
    return {
      available: this.availableSince !== null,
      ...(this.availableSince === null ? {} : { since: this.availableSince }),
      threads: [
        ...new Set([
          ...this.threads.keys(),
          ...(this.panelThread ? [this.panelThread.threadId] : [])
        ])
      ]
    }
  }

  /**
   * Mirror the device the agent named.
   *
   * A device id that is not there is not a failure of the call: the answer lists
   * the devices that are, which is what an agent needs to correct itself without
   * asking the user or guessing a serial.
   */
  async request(input: DisplayRequestInput): Promise<DisplayRequestResult> {
    const service = await displayService()
    const listing = await service.listSources(input.platform)
    const sources = listing.sources
    if (listing.problem) {
      return { ok: false, message: listing.problem, available: [] }
    }
    if (sources.length === 0) {
      return {
        ok: false,
        available: [],
        message:
          input.platform === 'android'
            ? 'No Android device is attached. Start the emulator or connect the device with adb, then call this again.'
            : 'No simulator is booted. Boot one with simctl, then call this again.'
      }
    }

    const wanted = input.device?.trim()
    const chosen = chooseDisplaySource(sources, wanted)
    if (!chosen) {
      return {
        ok: false,
        available: sources.map(optionFor),
        message: wanted
          ? `No ${input.platform} device matches "${wanted}". Use one of the ids in available.`
          : `More than one ${input.platform} device is available. Name the one you are working on.`
      }
    }

    const key = `${chosen.kind}:${chosen.sourceId}`
    const first = this.availableSince === null
    this.availableSince ??= Date.now()
    if (!this.threads.has(input.threadId)) {
      const at = Date.now()
      this.threads.set(input.threadId, { at, projectId: input.projectId ?? '' })
      sink?.activity({ threadId: input.threadId, active: true, at })
    }
    if (first) sink?.available()
    // The panel keeps showing this device, so asking twice is a no-op rather than
    // a stream restart.
    if (this.mirrored !== key) {
      this.mirrored = key
      sink?.target({
        target: chosen,
        threadId: input.threadId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        at: Date.now()
      })
    }
    return { ok: true, mirrored: optionFor(chosen), available: sources.map(optionFor) }
  }

  /** Stop mirroring, because the agent is done with the device. */
  release(threadId: string): DisplayRequestResult {
    this.clearThread(threadId)
    return { ok: true, message: 'Mirroring stopped. The device itself was not touched.' }
  }

  /**
   * Report what the panel is showing, so a repeat call does not reopen it and a
   * closed panel clears the marks that claimed a thread was driving something.
   *
   * `projectId` narrows that clearing to the project whose dock lost its tab: the
   * panel is per project, so a mirror that ends in one project says nothing about
   * a device another project's thread is still driving. Without it the app would
   * wipe every mark whenever the person looked at another project.
   */
  noteMirrored(key: string | null, threadId: string | null, projectId?: string): void {
    this.mirrored = key
    if (key === null) {
      const previous = this.panelThread
      if (previous !== null && (projectId === undefined || previous.projectId === projectId)) {
        this.panelThread = null
        if (!this.threads.has(previous.threadId)) {
          sink?.activity({ threadId: previous.threadId, active: false, at: Date.now() })
        }
      }
      for (const [asking, record] of [...this.threads.entries()]) {
        if (projectId === undefined || record.projectId === projectId) this.clearThread(asking)
      }
      return
    }
    if (
      threadId === null ||
      this.threads.has(threadId) ||
      this.panelThread?.threadId === threadId
    ) {
      return
    }
    const previous = this.panelThread
    if (previous !== null && !this.threads.has(previous.threadId)) {
      sink?.activity({ threadId: previous.threadId, active: false, at: Date.now() })
    }
    this.panelThread = { threadId, projectId: projectId ?? '' }
    this.availableSince ??= Date.now()
    sink?.activity({ threadId, active: true, at: Date.now() })
  }

  private clearThread(threadId: string): void {
    if (!this.threads.delete(threadId)) return
    sink?.activity({ threadId, active: false, at: Date.now() })
  }
}

export const displayRequests = new DisplayRequests()
