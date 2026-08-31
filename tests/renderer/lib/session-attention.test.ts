import { describe, expect, it } from 'vitest'
import { reconcilesPendingAttention } from '../../../src/renderer/lib/session-attention'

describe('reconcilesPendingAttention', () => {
  it('reconciles on waiting — the status a paused permission/question turn reports', () => {
    // Regression: this was missing until ThreadView.svelte's 'waiting' branch
    // was wired to it, leaving pending permission/question cards invisible
    // whenever the raw push event was missed or arrived with a stale
    // sessionId — only a full remount's fresh fetch ever surfaced them.
    expect(reconcilesPendingAttention('waiting')).toBe(true)
  })

  it('reconciles on idle', () => {
    expect(reconcilesPendingAttention('idle')).toBe(true)
  })

  it('does not reconcile while genuinely working', () => {
    expect(reconcilesPendingAttention('working')).toBe(false)
  })

  it('does not reconcile on a terminal error', () => {
    expect(reconcilesPendingAttention('error')).toBe(false)
  })
})
