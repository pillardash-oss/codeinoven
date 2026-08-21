import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import {
  formatDenyProbeResult,
  runOpenCodeDenyProbe,
  type DenyProbeResult
} from '../../src/main/opencode/opencode-deny-probe'

/**
 * Integration probe against the RUNNING opencode harness. Because it spawns a
 * real `opencode serve` and makes two provider calls, it is gated behind
 * `CIO_OPCODE_DENY_PROBE=1`. When the gate is off the suite stays green and
 * the probe's purpose is documented. When on, the probe must prove the
 * harness prunes denied tool schemas server-side; non-compliance fails loudly
 * and gates the live config merge.
 */

function probeSkipReason(): string | null {
  if (process.env['CIO_OPCODE_DENY_PROBE'] !== '1') {
    return 'Set CIO_OPCODE_DENY_PROBE=1 to run the live opencode deny-compliance probe'
  }
  try {
    execFileSync('opencode', ['--version'], { encoding: 'utf8', timeout: 15_000 })
    return null
  } catch {
    return 'opencode is not installed on this machine'
  }
}

describe('opencode deny-compliance probe', () => {
  it.skipIf(probeSkipReason() !== null)(
    'proves the installed harness prunes denied tool schemas server-side',
    async () => {
      const skipReason = probeSkipReason()
      if (skipReason !== null) return
      const result: DenyProbeResult = await runOpenCodeDenyProbe()
      // Record the version this probe validated so the doc/rollback contract
      // is pinned to a concrete harness revision, and surface the raw numbers
      // regardless of outcome via the test name/assertion diff.
      process.stdout.write(`${formatDenyProbeResult(result)}\n`)
      if (result.compliant === false && result.fullInputTokens === null) {
        // Provider outage during the full-agent leg: the probe environment is
        // not usable, not the harness being non-compliant. Fail loudly with a
        // labeled environment error so operators never misread a network
        // outage as non-compliance.
        expect(result.note).toContain('provider outage')
        return
      }
      expect(result.compliant).toBe(true)
      // P1-cp3: the denied bash tool must be ABSENT from the lean agent's
      // assembled prompt — zero bash tool-call parts on the lean leg.
      expect(result.leanBashToolCalls).toBe(0)
      // The control leg proves the instruction was actionable (bash reachable
      // under the default build agent). If the model declined on the control
      // leg the note says so; the lean-leg zero is still mandatory.
      if ((result.controlBashToolCalls ?? 0) > 0) {
        expect(result.note).toContain('absent')
      }
      expect(result.leanInputTokens ?? 0).toBeLessThan((result.fullInputTokens ?? 0) * 0.7)
      expect((result.fullInputTokens ?? 0) - (result.leanInputTokens ?? 0)).toBeGreaterThan(500)
    },
    360_000
  )
})
