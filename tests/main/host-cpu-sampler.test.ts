import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_CPU_SAMPLE_INTERVAL_MS,
  HOST_CPU_WINDOW_SAMPLES,
  HostCpuSampler,
  type HostCpuMetric
} from '../../src/main/agents/host-cpu-sampler'

// The app metrics are read through Electron, which no unit test runs inside.
vi.mock('electron', () => ({ app: { getAppMetrics: () => [] } }))

/** Process rows the test controls, keyed by pid. */
function scriptedMetrics(): {
  read: () => HostCpuMetric[]
  set: (pid: number, percent: number) => void
  drop: (pid: number) => void
} {
  const rows = new Map<number, number>()
  return {
    read: () => [...rows].map(([pid, percent]) => ({ pid, cpu: { percentCPUUsage: percent } })),
    set: (pid, percent) => rows.set(pid, percent),
    drop: (pid) => rows.delete(pid)
  }
}

describe('HostCpuSampler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers a host only once its window is full', () => {
    const metrics = scriptedMetrics()
    const sampler = new HostCpuSampler(metrics.read)
    metrics.set(500, 98)

    sampler.start()
    // The first reading of a process is Electron's warm-up, and one reading is
    // not a window: nothing is known yet.
    expect(sampler.sampling).toBe(true)
    expect(sampler.cpuPercent(500)).toBeNull()

    for (let turn = 1; turn < HOST_CPU_WINDOW_SAMPLES; turn += 1) sampler.sample()
    expect(sampler.cpuPercent(500)).toBeCloseTo(98)
  })

  it('averages the window instead of trusting one second', () => {
    const metrics = scriptedMetrics()
    const sampler = new HostCpuSampler(metrics.read)
    metrics.set(500, 0)
    sampler.sample()
    metrics.set(500, 99)
    sampler.sample()
    metrics.set(500, 99)
    sampler.sample()

    expect(sampler.cpuPercent(500)).toBeCloseTo(66)
  })

  it('keeps one host out of another host', () => {
    const metrics = scriptedMetrics()
    const sampler = new HostCpuSampler(metrics.read)
    for (let turn = 0; turn < HOST_CPU_WINDOW_SAMPLES; turn += 1) {
      metrics.set(500, 98)
      metrics.set(501, 2)
      sampler.sample()
    }

    expect(sampler.cpuPercent(500)).toBeCloseTo(98)
    expect(sampler.cpuPercent(501)).toBeCloseTo(2)
    expect(sampler.cpuPercent(999)).toBeNull()
  })

  it('forgets a host the machine no longer lists', () => {
    const metrics = scriptedMetrics()
    const sampler = new HostCpuSampler(metrics.read)
    metrics.set(500, 98)
    for (let turn = 0; turn < HOST_CPU_WINDOW_SAMPLES; turn += 1) sampler.sample()
    expect(sampler.cpuPercent(500)).not.toBeNull()

    // The host exited, so its reading must not answer for a process that is
    // gone, nor for a later process that inherits the pid.
    metrics.drop(500)
    sampler.sample()
    expect(sampler.cpuPercent(500)).toBeNull()
  })

  it('samples on its own cadence and not at all when stopped', () => {
    vi.useFakeTimers()
    const metrics = scriptedMetrics()
    const sampler = new HostCpuSampler(metrics.read)
    metrics.set(500, 40)
    sampler.start()
    // One reading, taken at the start, is not a window yet.
    expect(sampler.cpuPercent(500)).toBeNull()

    vi.advanceTimersByTime(HOST_CPU_SAMPLE_INTERVAL_MS)
    expect(sampler.cpuPercent(500)).toBeNull()

    vi.advanceTimersByTime(HOST_CPU_SAMPLE_INTERVAL_MS * (HOST_CPU_WINDOW_SAMPLES - 1))
    expect(sampler.cpuPercent(500)).toBeCloseTo(40)

    sampler.stop()
    expect(sampler.sampling).toBe(false)
    // Stopping is forgetting: nothing is asking for a reading any more.
    expect(sampler.cpuPercent(500)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores rows it cannot read', () => {
    const rows: HostCpuMetric[] = [
      { pid: 0, cpu: { percentCPUUsage: 90 } },
      { pid: -4, cpu: { percentCPUUsage: 90 } },
      { pid: 12.5, cpu: { percentCPUUsage: 90 } }
    ]
    const sampler = new HostCpuSampler(() => rows)
    for (let turn = 0; turn < HOST_CPU_WINDOW_SAMPLES; turn += 1) sampler.sample()

    expect(sampler.cpuPercent(0)).toBeNull()
    expect(sampler.cpuPercent(12.5)).toBeNull()
  })
})
