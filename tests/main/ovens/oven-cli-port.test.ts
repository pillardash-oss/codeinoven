import { describe, expect, it } from 'vitest'
import { resolveServingSshPort, sshPortCandidates } from '../../../packages/cio-oven/src/commands'

/**
 * The port a machine publishes is an answer it cannot verify from the outside,
 * so it is settled on the machine before a registration code is printed. These
 * cover the decision itself; the probe that feeds it dials real sockets.
 */
describe('oven CLI SSH port resolution', () => {
  it('leads with the reported port, then the standard one', () => {
    expect(sshPortCandidates(2222)).toEqual([2222, 22])
    expect(sshPortCandidates(null)).toEqual([22])
    // A reported 22 must not be dialled twice.
    expect(sshPortCandidates(22)).toEqual([22])
  })

  it('ignores ports that cannot be dialled', () => {
    expect(sshPortCandidates(0)).toEqual([22])
    expect(sshPortCandidates(70_000)).toEqual([22])
    expect(sshPortCandidates(NaN)).toEqual([22])
  })

  it('keeps the reported port when SSH answers there', async () => {
    expect(await resolveServingSshPort(2222, async (port) => port === 2222)).toBe(2222)
  })

  it('falls back to the standard port when the reported one is dead', async () => {
    expect(await resolveServingSshPort(2222, async (port) => port === 22)).toBe(22)
  })

  it('answers null when nothing serves SSH, so the caller can refuse', async () => {
    expect(await resolveServingSshPort(2222, async () => false)).toBeNull()
    expect(await resolveServingSshPort(22, async () => false)).toBeNull()
  })

  it('probes the candidates in order and stops at the first server', async () => {
    const probed: number[] = []
    const served = await resolveServingSshPort(2222, async (port) => {
      probed.push(port)
      return port === 22
    })
    expect(served).toBe(22)
    expect(probed).toEqual([2222, 22])
  })
})
