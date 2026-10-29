import { Session } from 'node:inspector/promises'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { isShippedBuild } from '../bootstrap/app-resources'
import { Logger } from './logger'

/**
 * Dev-only report of the main process holding its thread, and of what held it.
 *
 * A macOS window stops responding when the browser process blocks, and this
 * process is where the app does its file, IPC and service work. A duration alone
 * only says the window hitched, so the V8 sampling profiler runs while the app is
 * in development: when the event-loop monitor sees a stall, the samples of that
 * window are collapsed into the few functions that were on the stack, and they
 * are logged with the duration. That names the culprit instead of leaving a
 * guess behind.
 *
 * The sampling interval is coarse (2 ms) and the profiler is restarted after
 * each report, so the cost stays far below the stall being measured. Off in a
 * shipped build.
 */
const STALL_MS = 120
const SAMPLE_WINDOW_MS = 1_000
const SAMPLING_INTERVAL_MICROS = 2_000
const REPORTED_FUNCTIONS = 3
const NANOSECONDS_PER_MILLISECOND = 1e6

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
}

interface Profile {
  nodes: ProfileNode[]
  samples?: number[]
  timeDeltas?: number[]
}

/** The few functions that held the thread, heaviest first. */
function hotFunctions(profile: Profile): string[] {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const totals = new Map<string, number>()
  const samples = profile.samples ?? []
  for (let index = 0; index < samples.length; index += 1) {
    const node = nodes.get(samples[index])
    if (!node) continue
    const { functionName, url, lineNumber } = node.callFrame
    // V8 reports idle and its own bookkeeping with no source location; they say
    // the thread was free, which is the opposite of what this report is about.
    if (!url || functionName === '(idle)' || functionName === '(program)') continue
    const name = functionName === '(anonymous)' ? '(anonymous)' : functionName
    const file = url.split('/').slice(-1)[0]
    const key = `${name} @ ${file}:${lineNumber + 1}`
    totals.set(key, (totals.get(key) ?? 0) + (profile.timeDeltas?.[index] ?? 0))
  }
  return [...totals.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, REPORTED_FUNCTIONS)
    .map(([key, micros]) => `${key} ${Math.round(micros / 1000)}ms`)
}

export function installMainThreadWatch(): void {
  if (isShippedBuild()) return
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()

  const session = new Session()
  session.connect()
  let profiling = false
  const startProfiler = async (): Promise<void> => {
    await session.post('Profiler.enable')
    await session.post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_MICROS })
    await session.post('Profiler.start')
    profiling = true
  }

  let busy = false
  const report = async (maxMs: number): Promise<void> => {
    if (busy) return
    busy = true
    let hot: string[] = []
    try {
      if (profiling) {
        const stopped = (await session.post('Profiler.stop')) as { profile?: Profile }
        profiling = false
        if (stopped.profile) hot = hotFunctions(stopped.profile)
      }
    } catch {
      // A profiler that cannot be stopped must not swallow the report.
    }
    Logger.dev('Main thread stalled', hot.length ? { maxMs, hot } : { maxMs })
    try {
      await startProfiler()
    } catch {
      // Without a profiler the stall still gets reported, only without names.
    }
    busy = false
  }

  void startProfiler().catch(() => undefined)
  const timer = setInterval(() => {
    const maxMs = Math.round(histogram.max / NANOSECONDS_PER_MILLISECOND)
    histogram.reset()
    if (maxMs < STALL_MS) return
    void report(maxMs)
  }, SAMPLE_WINDOW_MS)
  timer.unref()
}
