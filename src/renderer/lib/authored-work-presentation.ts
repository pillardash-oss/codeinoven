import { Clapperboard, Palette } from '@lucide/svelte'
import type { Component } from 'svelte'
import type { AuthoredWorkKind } from '$shared/ipc-contract'

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

/** The glyph that marks the session, paired with the name for its label. */
export const AUTHORED_WORK_ICON_BY_KIND: Record<AuthoredWorkKind, Component> = {
  design: Palette,
  video: Clapperboard
}
