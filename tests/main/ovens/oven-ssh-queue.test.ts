import { describe, expect, it, vi } from 'vitest'
import { OvenSsh } from '../../../src/main/ovens/oven-ssh'
import type { OvenRegistry } from '../../../src/main/ovens/oven-registry'

/** A tail tick: enough microtasks for a queued command to be picked up. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * An OvenSsh whose SSH round trip is replaced by a promise we choose when to
 * settle, so the queue can be observed without a real connection.
 */
function controlled() {
  const ssh = new OvenSsh({} as OvenRegistry)
  const started: string[] = []
  const pending: Array<() => void> = []
  const run = vi.fn(
    (id: string) =>
      new Promise<string>((resolve) => {
        started.push(id)
        pending.push(() => resolve('done'))
      })
  )
  const internal = ssh as unknown as {
    run: typeof run
    cleanStaleCredentials: () => Promise<void>
  }
  internal.run = run as never
  // The stale-credential sweep needs the storage engine; this test is about order.
  internal.cleanStaleCredentials = async () => undefined
  return { ssh, started, pending }
}

describe('Oven SSH command queue', () => {
  it('runs commands to different Ovens together instead of one after another', async () => {
    const { ssh, started, pending } = controlled()
    const first = ssh.execute('oven-a', 'probe')
    const second = ssh.execute('oven-b', 'probe')
    await tick()
    // The second Oven starts while the first command is still outstanding.
    expect(started).toEqual(['oven-a', 'oven-b'])
    pending[0]?.()
    pending[1]?.()
    await Promise.all([first, second])
  })

  it('still runs one command at a time against a single Oven', async () => {
    const { ssh, started, pending } = controlled()
    const first = ssh.execute('oven-a', 'probe')
    const second = ssh.execute('oven-a', 'probe')
    await tick()
    expect(started).toEqual(['oven-a'])
    pending[0]?.()
    await tick()
    // Only once the first resolves does the second enter.
    expect(started).toEqual(['oven-a', 'oven-a'])
    pending[1]?.()
    await Promise.all([first, second])
  })

  it('lets a later Oven pass a stuck one rather than queueing behind it', async () => {
    const { ssh, started, pending } = controlled()
    const stuck = ssh.execute('oven-a', 'probe')
    const other = ssh.execute('oven-b', 'probe')
    const later = ssh.execute('oven-c', 'probe')
    await tick()
    expect(started).toEqual(['oven-a', 'oven-b', 'oven-c'])
    for (const release of pending) release()
    await Promise.all([stuck, other, later])
  })
})
