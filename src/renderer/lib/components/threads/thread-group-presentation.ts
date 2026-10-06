import { CircleCheck, CircleX, FileText, Inbox, Pickaxe } from '@lucide/svelte'
import type { Component } from 'svelte'
import TriangleQuestionMark from '$lib/components/icons/TriangleQuestionMark.svelte'
import type { ThreadGroup } from '$lib/stores/thread-grouping.svelte'

/** Header icon per status group, threads view only. Lucide has no
 *  triangle-question-mark, so Attention uses the in-house equivalent. */
export const THREAD_GROUP_ICONS: Record<ThreadGroup, Component> = {
  Attention: TriangleQuestionMark,
  Unread: Inbox,
  Errors: CircleX,
  Spec: FileText,
  Working: Pickaxe,
  Done: CircleCheck
}

/** Header colour per status group: the same variables the row statuses use. */
export const THREAD_GROUP_COLORS: Record<ThreadGroup, string> = {
  Attention: 'var(--color-warning)',
  Unread: 'var(--color-thread-unread)',
  Errors: 'var(--color-thread-error)',
  Spec: 'var(--color-thread-spec)',
  Working: 'var(--color-thread-working)',
  Done: 'var(--color-thread-done)'
}
