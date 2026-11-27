import { describe, expect, it } from 'vitest'
import { settleSelectedThreadRead } from '$lib/stores/selected-thread-read'

function row(read = false): { id: string; read: boolean } {
  return { id: 'thread-1', read }
}

describe('settleSelectedThreadRead', () => {
  it('clears the flag on the row the conversation is already derived from', () => {
    const selected = row()
    expect(settleSelectedThreadRead(selected, 'thread-1', true)).toBe(true)
    expect(selected.read).toBe(true)
  })

  it('never touches a row that is not the open thread', () => {
    const selected = row()
    expect(settleSelectedThreadRead(selected, 'another-thread', true)).toBe(false)
    expect(selected.read).toBe(false)
  })

  it('writes nothing when the flag already agrees', () => {
    const selected = row(true)
    expect(settleSelectedThreadRead(selected, 'thread-1', true)).toBe(false)
  })

  it('does nothing with no thread open', () => {
    expect(settleSelectedThreadRead(null, 'thread-1', true)).toBe(false)
  })
})
