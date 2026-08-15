import { describe, expect, it } from 'vitest'
import { StartupTelemetry } from '../../src/main/system/startup-telemetry'

describe('StartupTelemetry phase timestamps', () => {
  it('computes deltas relative to the previous phase, starting from zero', () => {
    let now = 1000
    const telemetry = new StartupTelemetry({ now: () => now })

    telemetry.mark('process:entry')
    expect(telemetry.recordedPhases[0]).toMatchObject({
      phase: 'process:entry',
      atMs: 0,
      deltaMs: 0
    })

    now += 500
    telemetry.mark('electron:ready')
    const first = telemetry.recordedPhases[1]!
    expect(first.phase).toBe('electron:ready')
    expect(first.atMs).toBe(500)
    // The first delta is simply the elapsed time since process entry.
    expect(first.deltaMs).toBe(500)

    now += 250
    telemetry.mark('splash:created')
    const second = telemetry.recordedPhases[2]!
    expect(second.atMs).toBe(750)
    // The delta is measured from the previous phase, not from origin.
    expect(second.deltaMs).toBe(250)
  })

  it('marks each phase exactly once', () => {
    let now = 0
    const telemetry = new StartupTelemetry({ now: () => now++ })
    telemetry.mark('process:entry')
    telemetry.mark('process:entry')
    telemetry.mark('process:entry')
    telemetry.mark('provider:warmup')
    telemetry.mark('provider:warmup')

    expect(telemetry.recordedPhases).toHaveLength(2)
    expect(telemetry.recordedPhases.map((p) => p.phase)).toEqual([
      'process:entry',
      'provider:warmup'
    ])
    expect(telemetry.hasMarked('process:entry')).toBe(true)
    expect(telemetry.hasMarked('electron:ready')).toBe(false)
  })

  it('keeps timestamps relative to origin and monotonically increasing', () => {
    let now = 10_000
    const telemetry = new StartupTelemetry({ now: () => now })
    for (const phase of [
      'nativeSplash:active',
      'process:entry',
      'electron:ready',
      'splash:created',
      'splash:visualReady',
      'storage:ready',
      'database:ready',
      'window:created',
      'renderer:documentLoaded',
      'window:visualReady',
      'renderer:hydrated',
      'features:ready',
      'workspace:ready',
      'provider:warmup'
    ] as const) {
      telemetry.mark(phase)
      now += 100
    }

    const phases = telemetry.recordedPhases
    expect(phases).toHaveLength(14)
    for (let index = 1; index < phases.length; index++) {
      expect(phases[index]!.atMs).toBeGreaterThan(phases[index - 1]!.atMs)
      expect(phases[index]!.deltaMs).toBeGreaterThan(0)
    }
    // atMs is relative to origin, never an absolute clock value.
    expect(phases[0]!.atMs).toBe(0)
    expect(phases[phases.length - 1]!.atMs).toBe(1300)
  })

  it('reset() clears recorded phases and the marked set', () => {
    const telemetry = new StartupTelemetry({ now: () => 1000 })
    telemetry.mark('process:entry')
    telemetry.reset()
    expect(telemetry.recordedPhases).toHaveLength(0)
    expect(telemetry.hasMarked('process:entry')).toBe(false)
  })
})

describe('StartupTelemetry event-loop delay', () => {
  it('reports zeros when the event-loop monitor was never started', () => {
    const telemetry = new StartupTelemetry({ now: () => 1000 })
    const snapshot = telemetry.snapshot()
    expect(snapshot.eventLoop).toEqual({
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      samples: 0
    })
  })
})
