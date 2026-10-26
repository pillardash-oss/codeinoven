import CioClapper from '@pdslng/cio-icon/CioClapper.svelte'
import CioPalette from '@pdslng/cio-icon/CioPalette.svelte'
import type { Component } from 'svelte'
import type { AuthoredWorkKind } from '$shared/ipc-contract'
import { ASSISTANT_SPACE_ID, GLOBAL_BROWSER_PROJECT_ID, INBOX_PROJECT_ID } from '$shared/types'

/**
 * How an authored-work session is named and drawn wherever a person sees it.
 *
 * One table for both, because the same session is labelled in more than one place: the
 * coordinator's rail tab calls it a coordinator, and a thread row marks it with the
 * glyph. A second copy is how a composition ends up drawn as a design in one of them.
 *
 * Renderer-only, because the glyphs are components; nothing in main can import this.
 */

/** What the session is called on its own, e.g. in a thread row's marker. */
export const AUTHORED_WORK_NAME_BY_KIND: Record<AuthoredWorkKind, string> = {
  design: 'Design',
  video: 'Video'
}

/**
 * What to call the place a scope's designs and videos live.
 *
 * A project thread's work is the project's. An assistant task, a chat and a
 * browser tab each write into a workspace of their own instead, so a label that
 * said "in this project" would send the user looking in a project that holds none
 * of it. One answer, because the rail entry, the board's list and its removal
 * question all name the same place.
 */
export function authoredWorkOwnerLabel(projectId: string): string {
  if (projectId === ASSISTANT_SPACE_ID) return 'this assistant'
  if (projectId === INBOX_PROJECT_ID) return 'this chat'
  if (projectId === GLOBAL_BROWSER_PROJECT_ID) return 'this browser'
  return 'this project'
}

/** The glyph that marks the session, paired with the name for its label. */
export const AUTHORED_WORK_ICON_BY_KIND: Record<AuthoredWorkKind, Component> = {
  design: CioPalette,
  video: CioClapper
}
