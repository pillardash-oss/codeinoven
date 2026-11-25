import { describe, expect, it } from 'vitest'
import type { ScreenshotCaptureOutcome } from '../../src/lib/types'
import {
  installScreenshotRequests,
  routeScreenshotCapture,
  type ScreenshotRequest,
  type ScreenshotRoutingHost
} from '../../src/main/system/screenshot-service/screenshot-router'

/**
 * Where a region capture lands when several instances are open.
 *
 * The chord is claimed system-wide, so one process holds it while the user may be
 * working in another. These cases pin the decision that keeps the capture in the
 * window the user is looking at, and the fallback that keeps the chord alive when
 * that window cannot be named or reached.
 */

const LOCAL_PID = 900_001
const PEER_PID = 900_002
const CAPTURED: ScreenshotCaptureOutcome = { status: 'cancelled' }

/** One instance's view of the routing host, with the peers it can reach. */
function host(options: {
  focusedPid?: number | null
  reachable?: number[]
}): ScreenshotRoutingHost & { captures: number; requested: number[] } {
  const state = {
    captures: 0,
    requested: [] as number[],
    localPid: LOCAL_PID,
    focusedInstancePid: () => options.focusedPid ?? null,
    requestRemoteCapture: (targetPid: number) => {
      state.requested.push(targetPid)
      return (options.reachable ?? []).includes(targetPid)
    },
    captureLocally: async () => {
      state.captures += 1
      return CAPTURED
    }
  }
  return state
}

describe('routeScreenshotCapture', () => {
  it('takes the capture itself when no instance has ever been focused', () => {
    const routing = host({ focusedPid: null })
    routeScreenshotCapture(routing)

    expect(routing.requested).toEqual([])
    expect(routing.captures).toBe(1)
  })

  it('takes the capture itself when this process owns the focused window', () => {
    const routing = host({ focusedPid: LOCAL_PID, reachable: [PEER_PID] })
    routeScreenshotCapture(routing)

    expect(routing.requested).toEqual([])
    expect(routing.captures).toBe(1)
  })

  it('asks the instance the user is in, without looking at its threads', () => {
    const routing = host({ focusedPid: PEER_PID, reachable: [PEER_PID] })
    routeScreenshotCapture(routing)

    expect(routing.requested).toEqual([PEER_PID])
    expect(routing.captures).toBe(0)
  })

  it('answers in this window rather than leaving the chord dead when the peer is unreachable', () => {
    const routing = host({ focusedPid: PEER_PID, reachable: [] })
    routeScreenshotCapture(routing)

    expect(routing.requested).toEqual([PEER_PID])
    expect(routing.captures).toBe(1)
  })
})

describe('installScreenshotRequests', () => {
  /** A request source the test feeds by hand. */
  function source(): {
    listen: (listener: (request: ScreenshotRequest) => void) => () => void
    send: (request: ScreenshotRequest) => void
  } {
    let listener: ((request: ScreenshotRequest) => void) | null = null
    return {
      listen: (next) => {
        listener = next
        return () => {
          listener = null
        }
      },
      send: (request) => listener?.(request)
    }
  }

  it('takes a capture for a request addressed here', () => {
    const routing = host({})
    const requests = source()
    installScreenshotRequests(routing, requests.listen)

    requests.send({
      requestId: 'peer:1',
      targetPid: LOCAL_PID,
      emittedAt: Date.now()
    })

    expect(routing.captures).toBe(1)
  })

  it('ignores a request addressed to another instance', () => {
    const routing = host({})
    const requests = source()
    installScreenshotRequests(routing, requests.listen)

    requests.send({ requestId: 'peer:2', targetPid: PEER_PID, emittedAt: Date.now() })

    expect(routing.captures).toBe(0)
  })

  it('ignores a request that waited too long to act on', () => {
    const routing = host({})
    const requests = source()
    installScreenshotRequests(routing, requests.listen)

    requests.send({ requestId: 'peer:3', targetPid: LOCAL_PID, emittedAt: Date.now() - 60_000 })

    expect(routing.captures).toBe(0)
  })

  it('answers one request once, even when it arrives twice', () => {
    const routing = host({})
    const requests = source()
    installScreenshotRequests(routing, requests.listen)
    const request = { requestId: 'peer:4', targetPid: LOCAL_PID, emittedAt: Date.now() }

    requests.send(request)
    requests.send(request)

    expect(routing.captures).toBe(1)
  })
})
