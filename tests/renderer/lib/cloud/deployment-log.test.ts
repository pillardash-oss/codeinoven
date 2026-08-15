import { describe, expect, it } from 'vitest'
import {
  formatCoolifyTimestamp,
  parseDeploymentLog,
  deploymentLogToText
} from '../../../../src/renderer/lib/cloud/deployment-log'

describe('formatCoolifyTimestamp', () => {
  it('formats an ISO timestamp into a readable date-time string', () => {
    expect(formatCoolifyTimestamp('2026-08-11T06:49:50.202938Z')).toBe(
      '2026-Aug-11 06:49:50.202938'
    )
  })

  it('handles fractional seconds with fewer digits', () => {
    expect(formatCoolifyTimestamp('2026-08-11T06:49:50.2Z')).toBe('2026-Aug-11 06:49:50.2')
  })

  it('returns the input unchanged when it is not ISO-shaped', () => {
    expect(formatCoolifyTimestamp('not-a-date')).toBe('not-a-date')
  })
})

describe('parseDeploymentLog', () => {
  it('parses a Coolify JSON log array into timestamp + output lines', () => {
    const raw = JSON.stringify([
      {
        command: null,
        output: 'Docker 29.6.2 with BuildKit detected.',
        type: 'stdout',
        timestamp: '2026-08-11T06:49:50.202938Z',
        hidden: false,
        batch: 1
      },
      {
        command: null,
        output: 'npm ERR! something failed',
        type: 'stderr',
        timestamp: '2026-08-11T06:50:00.123456Z',
        hidden: false,
        batch: 2
      }
    ])

    const lines = parseDeploymentLog(raw)
    expect(lines).toEqual([
      { text: '2026-Aug-11 06:49:50.202938', isError: false },
      { text: 'Docker 29.6.2 with BuildKit detected.', isError: false },
      { text: '2026-Aug-11 06:50:00.123456', isError: false },
      { text: 'npm ERR! something failed', isError: true }
    ])
  })

  it('marks only stderr lines as errors, regardless of text', () => {
    const lines = parseDeploymentLog(
      JSON.stringify([
        { output: 'ok', type: 'stdout', timestamp: '2026-08-11T06:49:50.202938Z' },
        {
          output: 'error in a commit message',
          type: 'stdout',
          timestamp: '2026-08-11T06:49:51.202938Z'
        },
        {
          output: 'npm ERR! something failed',
          type: 'stderr',
          timestamp: '2026-08-11T06:49:52.202938Z'
        },
        {
          output: 'Service built successfully',
          type: 'stderr',
          timestamp: '2026-08-11T06:49:53.202938Z'
        }
      ])
    )
    // The stream type is authoritative: both stderr lines are errors; stdout
    // lines are not, even when their text contains the word "error".
    expect(lines.filter((line) => line.isError).map((line) => line.text)).toEqual([
      'npm ERR! something failed',
      'Service built successfully'
    ])
  })

  it('splits multi-line output across separate lines', () => {
    const lines = parseDeploymentLog(
      JSON.stringify([
        { output: 'line one\nline two', type: 'stdout', timestamp: '2026-08-11T06:49:50.202938Z' }
      ])
    )
    expect(lines).toEqual([
      { text: '2026-Aug-11 06:49:50.202938', isError: false },
      { text: 'line one', isError: false },
      { text: 'line two', isError: false }
    ])
  })

  it('skips entries with empty output but keeps a non-empty line', () => {
    const lines = parseDeploymentLog(
      JSON.stringify([{ output: '', type: 'stdout', timestamp: '2026-08-11T06:49:50.202938Z' }])
    )
    expect(lines).toEqual([])
  })

  it('falls back to plain text lines when not a JSON array', () => {
    const lines = parseDeploymentLog('plain line one\nplain line two')
    expect(lines).toEqual([
      { text: 'plain line one', isError: false },
      { text: 'plain line two', isError: false }
    ])
  })

  it('never flags errors in the plain-text fallback (no stream info)', () => {
    const lines = parseDeploymentLog('Step 1 ok\nERROR: build failed')
    expect(lines).toEqual([
      { text: 'Step 1 ok', isError: false },
      { text: 'ERROR: build failed', isError: false }
    ])
  })

  it('returns an empty array for empty input', () => {
    expect(parseDeploymentLog('')).toEqual([])
    expect(parseDeploymentLog('   ')).toEqual([])
  })
})

describe('deploymentLogToText', () => {
  it('joins lines back into a single readable string', () => {
    const text = deploymentLogToText([
      { text: '2026-Aug-11 06:49:50.202938', isError: false },
      { text: 'some output', isError: true }
    ])
    expect(text).toBe('2026-Aug-11 06:49:50.202938\nsome output')
  })
})
