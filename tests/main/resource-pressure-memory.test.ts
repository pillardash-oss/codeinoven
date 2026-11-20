import { describe, expect, it } from 'vitest'
import { darwinAvailableBytes, linuxAvailableBytes } from '../../src/main/system/resource-pressure'

/** A real `vm_stat`, trimmed to the lines availability is read from. */
const MACOS_VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    67351.
Pages active:                                 247327.
Pages inactive:                               245313.
Pages speculative:                               915.
Pages throttled:                                   0.
Pages wired down:                             163661.
Pages purgeable:                                 120.
`

describe('available memory', () => {
  it('counts the pages macOS can reclaim, not just free ones', () => {
    const bytes = darwinAvailableBytes(MACOS_VM_STAT)
    // free 67351 + inactive 245313 + speculative 915 + purgeable 120 pages of 16 KB.
    expect(bytes).toBe((67351 + 245313 + 915 + 120) * 16384)
  })

  it('reads the page size from the output instead of assuming 4 KB', () => {
    const bytes = darwinAvailableBytes(MACOS_VM_STAT)
    expect(bytes).toBeGreaterThan(67351 * 4096)
  })

  it('answers null when the output is not vm_stat', () => {
    expect(darwinAvailableBytes('unexpected')).toBeNull()
  })

  it('takes MemAvailable from /proc/meminfo', () => {
    const meminfo = `MemTotal:       16311156 kB
MemFree:          548428 kB
MemAvailable:    2941276 kB
Buffers:          120832 kB
`
    expect(linuxAvailableBytes(meminfo)).toBe(2941276 * 1024)
  })

  it('answers null when MemAvailable is missing', () => {
    expect(linuxAvailableBytes('MemTotal: 1000 kB\nMemFree: 100 kB\n')).toBeNull()
  })
})
