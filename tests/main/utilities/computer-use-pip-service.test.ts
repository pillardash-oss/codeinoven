import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { ComputerUsePipFrame, ComputerUsePipState } from '../../../src/lib/types'
import { Logger } from '../../../src/main/system/logger'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import {
  ComputerUsePipService,
  frameCapFor
} from '../../../src/main/utilities/computer-use-pip-service'

/**
 * Capture resilience for the computer-use PiP.
 *
 * The regression these tests pin: the driver can answer `get_window_state` for a
 * window it will not photograph at that moment (the AX tree arrives, the image
 * does not, and the refusal resolves with `isError: true` instead of rejecting).
 * The monitor used to retry that same window every frame, spend its whole miss
 * budget in about one second, and hide the preview for the rest of the run, with
 * nothing left to re-latch it while the run's later operations were
 * desktop-scoped.
 *
 * Verified against the pre-fix implementation (`d8e074fa^`): the walk, cooldown,
 * painted-frame, four-window and rejected-call tests fail there, and a capture
 * that never leaves the ranked head is exactly what fails them.
 */

const harness = vi.hoisted(() => {
  type Sent = { channel: string; payload: unknown }
  const sent: Sent[] = []
  const webContents = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload })
    }
  }
  const window = { isDestroyed: () => false, webContents }
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 400, height: 200 }),
    resize: () => image,
    toJPEG: () => Buffer.from('jpeg-bytes')
  }
  return {
    sent,
    getAllWindows: () => [window],
    createFromDataURL: () => image,
    connect: vi.fn<() => Promise<unknown>>()
  }
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: harness.getAllWindows },
  nativeImage: { createFromDataURL: harness.createFromDataURL }
}))

vi.mock('../../../src/main/agents/mcp-stdio-client', () => ({
  StdioMcpClient: { connect: harness.connect }
}))

vi.mock('../../../src/main/utilities/cua-bridge-service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/main/utilities/cua-bridge-service')>()
  return {
    ...actual,
    CuaBridgeService: class {
      claimDaemonMode = vi.fn(async () => undefined)
      releaseDaemonClaim = vi.fn(async () => undefined)
      resolveUtility = vi.fn(async () => ({
        utility: {
          id: 'cio:cua-driver',
          kind: 'mcp',
          name: 'Cua Computer Use',
          enabled: true,
          activation: 'on_demand',
          description: '',
          scope: { level: 'global' },
          config: { transport: 'stdio', command: 'cua-driver', args: ['mcp'], environment: {} }
        }
      }))
    }
  }
})

vi.mock('../../../src/main/system/logger', () => ({
  Logger: { dev: vi.fn(), info: vi.fn(), error: vi.fn(), flush: vi.fn() }
}))

/** One frame's interval, the loop's own cadence. */
const FRAME_MS = 67
/** The monitor's pause between attempts while frames are failing. */
const RETRY_MS = 250

interface DriverCall {
  name: string
  input: Record<string, unknown>
}

interface DriverWindow {
  window_id: number
  z_index: number
  app_name?: string
  bounds?: { x: number; y: number; width: number; height: number }
}

function listResult(windows: DriverWindow[]): unknown {
  return {
    structuredContent: {
      windows: windows.map((window) => ({ is_on_screen: true, app_name: 'Notes', ...window }))
    }
  }
}

function frameResult(): unknown {
  return {
    content: [{ type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }],
    structuredContent: { screenshot_width: 400, screenshot_height: 200 }
  }
}

/** A resolved refusal, which is how the driver declines a window capture. */
function refusalResult(
  text = 'px_capture_unavailable: the window has no provable screenshot'
): unknown {
  return { isError: true, content: [{ type: 'text', text }] }
}

/** A refusal that also says the MCP server lost the shared daemon. */
const TRANSPORT_REFUSAL =
  'MCP server `/Applications/CuaDriver.app/Contents/MacOS/cua-driver` failed: daemon transport error forwarding `get_window_state`: daemon closed'

/** A driver connection scripted per test: every `callTool` is recorded in order. */
function scriptedDriver(handle: (name: string, input: Record<string, unknown>) => unknown) {
  const calls: DriverCall[] = []
  const close = vi.fn(async () => undefined)
  const client = {
    listTools: async (): Promise<unknown[]> => [],
    callTool: async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input })
      return handle(name, input)
    },
    close
  }
  return { client, calls, close }
}

const services: ComputerUsePipService[] = []

function pipFor(driver: ReturnType<typeof scriptedDriver>): ComputerUsePipService {
  harness.connect.mockImplementation(async () => driver.client)
  const service = new ComputerUsePipService(
    new StorageEngine(join(process.cwd(), '.cio', 'tmp', 'pip-service-test'))
  )
  services.push(service)
  return service
}

/** Drain the capture's await chain (mocked promises resolve immediately).
 *
 * The chain is about a dozen awaits deep and the bound is deliberately generous:
 * a chain that suddenly needs more turns means something in the path stopped
 * resolving, and failing on the assertions beats hanging the suite. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
}

async function nextFrame(ms = FRAME_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

/** Exactly one more capture attempt after a failed one: the retry pause plus the
 *  frame tick that lands past it. */
async function nextAttempt(): Promise<void> {
  await nextFrame(RETRY_MS + FRAME_MS)
}

interface LatchOptions {
  sessionId?: string
  cursor?: { x: number; y: number } | null
}

/** One computer-use operation, which is what latches the monitor onto a pid. */
async function latch(
  pip: ComputerUsePipService,
  pid: number,
  options: LatchOptions = {}
): Promise<void> {
  pip.onActivity({
    threadId: 'thread-1',
    operation: 'list_windows',
    pid,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    cursor: options.cursor ?? null,
    permissionLevel: 'auto_review'
  })
  await settle()
}

function pipFrames(): ComputerUsePipFrame[] {
  return harness.sent
    .filter((entry) => entry.channel === 'computerUse:pipFrame')
    .map((entry) => entry.payload as ComputerUsePipFrame)
}

function pipStates(): ComputerUsePipState[] {
  return harness.sent
    .filter((entry) => entry.channel === 'computerUse:pipState')
    .map((entry) => entry.payload as ComputerUsePipState)
}

/** The window ids the capture asked to photograph, in order. */
function windowAttempts(driver: ReturnType<typeof scriptedDriver>): number[] {
  return driver.calls
    .filter((call) => call.name === 'get_window_state')
    .map((call) => Number(call.input['window_id']))
}

function unavailableLogs(): unknown[] {
  return vi
    .mocked(Logger.dev)
    .mock.calls.filter((args) => String(args[0]).startsWith('Computer-use PiP frame unavailable'))
}

beforeEach(() => {
  vi.useFakeTimers()
  harness.sent.length = 0
  harness.connect.mockReset()
  vi.clearAllMocks()
})

afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  vi.useRealTimers()
})

describe('computer-use PiP capture resilience', () => {
  it('falls through to the next ranked window when the driver refuses the frontmost one', async () => {
    const driver = scriptedDriver((name, input) =>
      name === 'list_windows'
        ? listResult([
            { window_id: 1, z_index: 90 },
            { window_id: 2, z_index: 80 }
          ])
        : input['window_id'] === 1
          ? refusalResult()
          : frameResult()
    )
    const pip = pipFor(driver)

    await latch(pip, 7)

    expect(windowAttempts(driver)).toEqual([1, 2])
    const frames = pipFrames()
    expect(frames).toHaveLength(1)
    expect(frames[0]?.windowId).toBe(2)
    expect(pip.getState().active).toBe(true)
  })

  it('skips a refused window for its cooldown, then gives it another chance', async () => {
    const driver = scriptedDriver((name, input) =>
      name === 'list_windows'
        ? listResult([
            { window_id: 1, z_index: 90 },
            { window_id: 2, z_index: 80 }
          ])
        : input['window_id'] === 1
          ? refusalResult()
          : frameResult()
    )
    const pip = pipFor(driver)

    await latch(pip, 7)
    expect(windowAttempts(driver)).toEqual([1, 2])

    // Several healthy frames: the refused window stays out of the way.
    await nextFrame(500)
    expect(
      windowAttempts(driver)
        .slice(2)
        .every((windowId) => windowId === 2)
    ).toBe(true)

    // Past the cooldown the ranking is honoured again, and the fall-through still
    // keeps the frame when the head is refused a second time.
    await nextFrame(5_000)
    const attempts = windowAttempts(driver)
    const retried = attempts.lastIndexOf(1)
    expect(retried).toBeGreaterThan(2)
    expect(attempts[retried + 1]).toBe(2)
  })

  it('keeps a painted frame instead of hiding when the driver starts refusing', async () => {
    let captures = 0
    const driver = scriptedDriver((name) => {
      if (name === 'list_windows') return listResult([{ window_id: 5, z_index: 90 }])
      captures += 1
      return captures === 1 ? frameResult() : refusalResult()
    })
    const pip = pipFor(driver)

    await latch(pip, 9)
    expect(pipFrames()).toHaveLength(1)

    // Twelve more attempts is about four seconds of refusals: the old budget
    // spent fifteen frames in one second and left the user with no preview.
    for (let attempt = 0; attempt < 12; attempt += 1) await nextAttempt()
    expect(pip.getState().active).toBe(true)
    expect(pipStates().some((state) => state.active === false)).toBe(false)
    expect(unavailableLogs()).toHaveLength(1)

    // The budget is finite: the last frame is held, not shown forever.
    for (let attempt = 0; attempt < 12; attempt += 1) await nextAttempt()
    expect(pip.getState().active).toBe(false)
    expect(pipStates().at(-1)?.active).toBe(false)
  })

  it('lets a run that never painted a frame go quickly, without lingering', async () => {
    const driver = scriptedDriver((name) =>
      name === 'list_windows' ? listResult([{ window_id: 5, z_index: 90 }]) : refusalResult()
    )
    const pip = pipFor(driver)

    await latch(pip, 9)
    await nextFrame(500)

    expect(pip.getState().active).toBe(true)
    expect(pipFrames()).toHaveLength(0)

    await nextFrame(3_000)

    expect(pip.getState().active).toBe(false)
    expect(pipFrames()).toHaveLength(0)
    expect(unavailableLogs()).toHaveLength(1)
  })

  it('draws the run cursor inside the frame it painted', async () => {
    const driver = scriptedDriver((name) =>
      name === 'list_windows'
        ? listResult([
            { window_id: 5, z_index: 90, bounds: { x: 0, y: 0, width: 100, height: 50 } }
          ])
        : frameResult()
    )
    const pip = pipFor(driver)

    await latch(pip, 9, { sessionId: 'session-1', cursor: { x: 10, y: 5 } })

    // The window is 100x50 points and the frame is 400x200 pixels, so the point
    // scales by four on each axis.
    expect(pipFrames()[0]?.cursor).toEqual({ visible: true, x: 40, y: 20 })
  })

  it('leaves the frame without a cursor when the run has not moved one', async () => {
    const driver = scriptedDriver((name) =>
      name === 'list_windows'
        ? listResult([
            { window_id: 5, z_index: 90, bounds: { x: 0, y: 0, width: 100, height: 50 } }
          ])
        : frameResult()
    )
    const pip = pipFor(driver)

    await latch(pip, 9, { sessionId: 'session-1' })

    expect(pipFrames()[0]).not.toHaveProperty('cursor')
  })

  it('ends the run at once when the driver loses its daemon', async () => {
    const driver = scriptedDriver((name) =>
      name === 'list_windows'
        ? listResult([
            { window_id: 1, z_index: 90 },
            { window_id: 2, z_index: 80 }
          ])
        : refusalResult(TRANSPORT_REFUSAL)
    )
    const pip = pipFor(driver)

    await latch(pip, 7)

    expect(windowAttempts(driver)).toEqual([1])
    expect(driver.close).toHaveBeenCalledTimes(1)
    expect(pip.getState().active).toBe(false)
    expect(pipStates().at(-1)?.active).toBe(false)
    expect(
      vi
        .mocked(Logger.error)
        .mock.calls.some((args) => String(args[0]).includes('daemon transport error'))
    ).toBe(true)
  })

  it('drops a refusal recorded by a run that was already replaced', async () => {
    let refuseFirstRun: (value: unknown) => void = () => undefined
    const firstRunCapture = new Promise((resolve) => {
      refuseFirstRun = resolve
    })
    const driver = scriptedDriver((name, input) => {
      if (name === 'list_windows') {
        return listResult(
          input['pid'] === 1
            ? [{ window_id: 5, z_index: 90 }]
            : [
                { window_id: 5, z_index: 90 },
                { window_id: 6, z_index: 80 }
              ]
        )
      }
      return input['pid'] === 1 ? firstRunCapture : frameResult()
    })
    const pip = pipFor(driver)

    await latch(pip, 1)
    await latch(pip, 2)
    refuseFirstRun(refusalResult())
    await settle()
    await nextFrame(RETRY_MS)

    // The successor run ranks its own window 5 first: the replaced run's refusal
    // must not leave a cooldown behind that would push it to window 6.
    const successorAttempts = driver.calls.filter(
      (call) => call.name === 'get_window_state' && call.input['pid'] === 2
    )
    expect(successorAttempts[0]?.input['window_id']).toBe(5)
    expect(pipFrames().length).toBeGreaterThan(0)
    expect(pipFrames().every((frame) => frame.pid === 2)).toBe(true)
  })

  it('stops one frame after three refused windows and reaches the fourth on the next', async () => {
    const driver = scriptedDriver((name, input) =>
      name === 'list_windows'
        ? listResult([
            { window_id: 1, z_index: 90 },
            { window_id: 2, z_index: 80 },
            { window_id: 3, z_index: 70 },
            { window_id: 4, z_index: 60 }
          ])
        : input['window_id'] === 4
          ? frameResult()
          : refusalResult()
    )
    const pip = pipFor(driver)

    await latch(pip, 7)

    // One frame tries the ranked head plus the two behind it, so the fourth
    // window waits for the next frame, once the first three are cooling.
    expect(windowAttempts(driver)).toEqual([1, 2, 3])
    expect(pipFrames()).toHaveLength(0)

    await nextAttempt()

    expect(windowAttempts(driver)).toEqual([1, 2, 3, 4])
    expect(pipFrames().map((frame) => frame.windowId)).toEqual([4])
  })

  it('resets the painted-frame budget when the run is replaced', async () => {
    const driver = scriptedDriver((name, input) => {
      if (name === 'list_windows') {
        return listResult([{ window_id: input['pid'] === 1 ? 5 : 6, z_index: 90 }])
      }
      return input['pid'] === 1 ? frameResult() : refusalResult()
    })
    const pip = pipFor(driver)

    await latch(pip, 1)
    expect(pipFrames()).toHaveLength(1)

    await latch(pip, 2)
    for (let attempt = 0; attempt < 12; attempt += 1) await nextAttempt()

    // The successor never painted, so it ages out on the short budget instead of
    // inheriting the held-frame one from the run it replaced.
    expect(pip.getState().active).toBe(false)
  })

  it('treats a rejected driver call as a failed frame and keeps the run alive', async () => {
    let captures = 0
    const driver = scriptedDriver((name) => {
      if (name === 'list_windows') return listResult([{ window_id: 5, z_index: 90 }])
      captures += 1
      if (captures === 1) throw new Error('get_window_state timed out')
      return frameResult()
    })
    const pip = pipFor(driver)

    await latch(pip, 9)

    expect(pipFrames()).toHaveLength(0)
    expect(pip.getState().active).toBe(true)
    expect(
      vi
        .mocked(Logger.error)
        .mock.calls.some((args) => String(args[0]).includes('the driver call failed'))
    ).toBe(true)

    // The next attempt still runs: a rejecting call must not wedge the frame gate.
    await nextAttempt()

    expect(pipFrames().map((frame) => frame.windowId)).toEqual([5])
  })

  it('ends the run at once when the rejected call is a lost daemon', async () => {
    const driver = scriptedDriver((name) => {
      if (name === 'list_windows') return listResult([{ window_id: 5, z_index: 90 }])
      throw new Error(`get_window_state rejected: ${TRANSPORT_REFUSAL}`)
    })
    const pip = pipFor(driver)

    await latch(pip, 9)

    expect(driver.close).toHaveBeenCalledTimes(1)
    expect(pip.getState().active).toBe(false)
  })
})

describe('frameCapFor', () => {
  it('clamps the renderer demand between the default footprint and the measured ceiling', () => {
    expect(frameCapFor(null)).toBe(448)
    expect(frameCapFor(Number.NaN)).toBe(448)
    expect(frameCapFor(128)).toBe(448)
    expect(frameCapFor(600)).toBe(600)
    expect(frameCapFor(1_344)).toBe(896)
  })
})
