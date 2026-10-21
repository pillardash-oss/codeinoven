import { describe, expect, it } from 'vitest'
import { RowPageBudget, THREAD_LIST_PAGE_SIZE } from '$lib/components/shared/RowPageBudget.svelte'
import { rowArrangement } from '$lib/motion'

/**
 * The shared row-budget and arrangement helpers behind every sidebar list.
 *
 * These lock in the memory contract the thread-family lists rely on: a list
 * mounts one page plus at most the active row, and the reflow arrangement string
 * changes only when the rows really changed. The rendering tests next to this one
 * (sidebar-list-parity) prove the sidebars actually call into these helpers; this
 * one pins the numbers.
 */

function rows(count: number, prefix = 'row'): { id: string }[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` }))
}

describe('RowPageBudget', () => {
  it('mounts one page before the list grows, and only one object per list', () => {
    const budget = new RowPageBudget()
    const all = rows(40)

    expect(budget.visibleCount('chats')).toBe(THREAD_LIST_PAGE_SIZE)
    expect(budget.visibleRows('chats', all, null)).toHaveLength(THREAD_LIST_PAGE_SIZE)
    // A second list has its own budget.
    expect(budget.visibleRows('standalone', all, null)).toHaveLength(THREAD_LIST_PAGE_SIZE)
  })

  it('grows by one page at a time', () => {
    const budget = new RowPageBudget()
    const all = rows(100)

    budget.showMore('chats', all.length)
    expect(budget.visibleCount('chats')).toBe(THREAD_LIST_PAGE_SIZE * 2)
    budget.showMore('chats', all.length)
    expect(budget.visibleCount('chats')).toBe(THREAD_LIST_PAGE_SIZE * 3)
  })

  it('never grows past the total', () => {
    const budget = new RowPageBudget()
    budget.showMore('chats', 20)
    expect(budget.visibleCount('chats')).toBe(20)
    budget.showMore('chats', 20)
    expect(budget.visibleCount('chats')).toBe(20)
  })

  it('drops back to the first page on show less', () => {
    const budget = new RowPageBudget()
    const all = rows(40)
    budget.showMore('chats', all.length)
    budget.showLess('chats')
    expect(budget.visibleRows('chats', all, null)).toHaveLength(THREAD_LIST_PAGE_SIZE)
  })

  it('keeps the active row even when it sits beyond the page', () => {
    const budget = new RowPageBudget()
    const all = rows(40)
    const active = all[30]

    const visible = budget.visibleRows('chats', all, active.id)
    expect(visible).toHaveLength(THREAD_LIST_PAGE_SIZE + 1)
    expect(visible.at(-1)?.id).toBe(active.id)
    // The artificial active row is not counted as hidden.
    expect(budget.hiddenCount(all, visible)).toBe(all.length - THREAD_LIST_PAGE_SIZE - 1)
  })

  it('does not duplicate the active row when it is already on the page', () => {
    const budget = new RowPageBudget()
    const all = rows(40)
    const visible = budget.visibleRows('chats', all, all[0].id)
    expect(visible).toHaveLength(THREAD_LIST_PAGE_SIZE)
    expect(new Set(visible.map((row) => row.id)).size).toBe(visible.length)
  })

  it('forgets a list so its budget cannot outlive its rows', () => {
    const budget = new RowPageBudget()
    budget.showMore('chats', 40)
    budget.forget('chats')
    expect(budget.visibleCount('chats')).toBe(THREAD_LIST_PAGE_SIZE)
  })
})

describe('rowArrangement', () => {
  it('is stable for the same rows and changes when they move', () => {
    const first = rowArrangement([
      { key: 'group:a', rowKeys: ['1', '2'] },
      { key: 'group:b', rowKeys: ['3'] }
    ])
    const same = rowArrangement([
      { key: 'group:a', rowKeys: ['1', '2'] },
      { key: 'group:b', rowKeys: ['3'] }
    ])
    const reordered = rowArrangement([
      { key: 'group:a', rowKeys: ['2', '1'] },
      { key: 'group:b', rowKeys: ['3'] }
    ])

    expect(first).toBe(same)
    expect(first).not.toBe(reordered)
  })

  it('tells a regrouped row apart from a recency reorder', () => {
    const before = rowArrangement([
      { key: 'group:working', rowKeys: ['a', 'b'] },
      { key: 'group:done', rowKeys: [] }
    ])
    const regrouped = rowArrangement([
      { key: 'group:working', rowKeys: ['a'] },
      { key: 'group:done', rowKeys: ['b'] }
    ])
    expect(before).not.toBe(regrouped)
  })
})
