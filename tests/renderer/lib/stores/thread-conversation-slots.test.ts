import { describe, expect, it } from 'vitest'

import {
  CONVERSATION_SLOTS,
  planSlots,
  pushOpenedSlot
} from '$lib/stores/thread-conversation-slots'

describe('pushOpenedSlot', () => {
  it('puts a new conversation at the tail of the stack', () => {
    expect(pushOpenedSlot(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
  })

  it('moves a conversation that is already in the stack instead of adding it twice', () => {
    expect(pushOpenedSlot(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a'])
  })

  it('never mutates the stack it was given', () => {
    const stack = ['a', 'b']
    pushOpenedSlot(stack, 'c')
    expect(stack).toEqual(['a', 'b'])
  })
})

describe('planSlots', () => {
  it('keeps the three most recently opened conversations and drops the rest', () => {
    const plan = planSlots({
      openOrder: ['a', 'b', 'c', 'd'],
      resident: ['a', 'b', 'c', 'd'],
      held: []
    })

    expect(plan.retained).toEqual(['b', 'c', 'd'])
    expect(plan.evicted).toEqual(['a'])
    expect(plan.openOrder).toEqual(['b', 'c', 'd'])
  })

  it('retains a conversation a mounted reader holds even when it left the stack', () => {
    const plan = planSlots({
      openOrder: ['a', 'b', 'c', 'd'],
      resident: ['a', 'b', 'c', 'd'],
      held: ['a']
    })

    expect(plan.retained).toEqual(['a', 'b', 'c', 'd'])
    expect(plan.evicted).toEqual([])
    // A held conversation is protected, not promoted: the stack keeps its order.
    expect(plan.openOrder).toEqual(['a', 'b', 'c', 'd'])
  })

  it('drops a held key from the plan but not from the cache when it has no entry', () => {
    const plan = planSlots({ openOrder: ['a'], resident: ['a'], held: ['ghost'] })

    expect(plan.retained).toEqual(['a'])
    expect(plan.evicted).toEqual([])
    expect(plan.openOrder).toEqual(['a'])
  })

  it('evicts a resident transcript no open ever claimed, such as a cold preload', () => {
    const plan = planSlots({
      openOrder: ['a', 'b', 'c'],
      resident: ['a', 'b', 'c', 'preload'],
      held: []
    })

    expect(plan.evicted).toEqual(['preload'])
  })

  it('takes the slot count it is given', () => {
    const plan = planSlots({ openOrder: ['a', 'b'], resident: ['a', 'b'], held: [], slots: 1 })

    expect(plan.retained).toEqual(['b'])
    expect(plan.evicted).toEqual(['a'])
  })

  it('keeps one slot even when asked for none', () => {
    const plan = planSlots({ openOrder: ['a', 'b'], resident: ['a', 'b'], held: [], slots: 0 })

    expect(plan.retained).toEqual(['b'])
  })

  it('defaults to three slots', () => {
    const openOrder = ['a', 'b', 'c', 'd']
    const plan = planSlots({ openOrder, resident: openOrder, held: [] })

    expect(plan.retained).toHaveLength(CONVERSATION_SLOTS)
    expect(CONVERSATION_SLOTS).toBe(3)
  })
})
