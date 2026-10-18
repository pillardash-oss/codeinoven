import type { Component } from 'svelte'
import type { ThreadGroup } from '$lib/stores/thread-grouping.svelte'
import CioHammer from '@codeio/icon/CioHammer.svelte'
import { THREAD_GROUP_MARK } from './thread-state-marks'

/**
 * Header icon per status group, threads view only.
 *
 * The glyph comes from the same registry the rows use, so a group header can
 * never disagree with the rows underneath it: the specification is a toolbox in
 * both, and attention is the in-house triangle-question-mark in both.
 */
export const THREAD_GROUP_ICONS: Record<ThreadGroup, Component> = {
  Attention: THREAD_GROUP_MARK.Attention.icon,
  Drafts: THREAD_GROUP_MARK.Drafts.icon,
  Unread: THREAD_GROUP_MARK.Unread.icon,
  Errors: THREAD_GROUP_MARK.Errors.icon,
  Spec: THREAD_GROUP_MARK.Spec.icon,
  Working: CioHammer,
  Done: THREAD_GROUP_MARK.Done.icon
}

/** Header colour per status group: the same colour the rows paint with. */
export const THREAD_GROUP_COLORS: Record<ThreadGroup, string> = {
  Attention: THREAD_GROUP_MARK.Attention.colour,
  Drafts: THREAD_GROUP_MARK.Drafts.colour,
  Unread: THREAD_GROUP_MARK.Unread.colour,
  Errors: THREAD_GROUP_MARK.Errors.colour,
  Spec: THREAD_GROUP_MARK.Spec.colour,
  Working: THREAD_GROUP_MARK.Working.colour,
  Done: THREAD_GROUP_MARK.Done.colour
}
