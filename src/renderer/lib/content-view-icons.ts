import { BotMessageSquare, MessageSquare } from '@lucide/svelte'
import type { Component } from 'svelte'
import type { Thread } from '$shared/types'
import { contentThreadFamily, type ContentThreadFamily } from './content-view-threads'

/**
 * The mark of every content-view family that is not a user project.
 *
 * The Chats inbox and the Assistant container are hidden projects with no icon
 * of their own, so a surface that labels a thread by the container it lives in
 * (the Ctrl+Tab thread switcher) draws the same glyph the view switcher uses for
 * that view instead of leaving the slot blank. A project thread resolves its own
 * project icon and never needs these.
 */
export const CONTENT_FAMILY_ICONS: Record<Exclude<ContentThreadFamily, 'projects'>, Component> = {
  chats: MessageSquare,
  assistant: BotMessageSquare
}

/**
 * The container glyph for a thread that lives in a hidden container, or null for
 * a project thread   its container draws the project's own icon instead.
 */
export function contentFamilyIcon(thread: Pick<Thread, 'projectId'>): Component | null {
  const family = contentThreadFamily(thread)
  return family === 'projects' ? null : CONTENT_FAMILY_ICONS[family]
}
