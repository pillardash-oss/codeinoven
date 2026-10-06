import { describe, expect, it } from 'vitest'
import { ovenRootKeyFor, parseOvenRootKey } from '../../../src/lib/oven-root-routing'

/**
 * The remote scope key is written by the renderer and read by the main process,
 * so its format is a contract between two ends that cannot see each other. These
 * pin the round trip and the cases each end must reject.
 */
describe('remote checkout key', () => {
  it('round-trips the thread and Oven it names', () => {
    const key = ovenRootKeyFor('31e809e7a6f14fe424e58b90', '94a8f4d3-bddb-45bd-9355-10f66091db6e')
    expect(parseOvenRootKey(key)).toEqual({
      threadId: '31e809e7a6f14fe424e58b90',
      ovenId: '94a8f4d3-bddb-45bd-9355-10f66091db6e'
    })
  })

  it('rejects anything that is not one of its own keys', () => {
    expect(parseOvenRootKey(undefined)).toBeNull()
    expect(parseOvenRootKey('')).toBeNull()
    expect(parseOvenRootKey('scope-bucket-1')).toBeNull()
    expect(parseOvenRootKey('oven.only-one-part')).toBeNull()
    expect(parseOvenRootKey('oven.a.b.c')).toBeNull()
  })
})
