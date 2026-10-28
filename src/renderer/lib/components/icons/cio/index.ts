/**
 * App icon registry: the shared CIO glyph package plus marks specific to the app.
 *
 * Every drawn glyph lives in `@pdslng/cio-icon`, which the app installs from npm.
 * Only the app's own marks are hand-authored here, so a surface that resolves a
 * mark at runtime looks one registry up by id and no glyph is drawn twice.
 */
import type { Component } from 'svelte'
import { CIO_ICONS as SHARED_CIO_ICONS } from '@pdslng/cio-icon'
import AssistantIcon from './AssistantIcon.svelte'
import AssistantDefaultIcon from './AssistantDefaultIcon.svelte'
import AssistantKnowledgeIcon from './AssistantKnowledgeIcon.svelte'
import AssistantTaskIcon from './AssistantTaskIcon.svelte'
import CioMonogram from './CioMonogram.svelte'
import TriangleQuestionMark from './TriangleQuestionMark.svelte'

export const CIO_ICONS = {
  ...SHARED_CIO_ICONS,
  assistant: AssistantIcon,
  monogram: CioMonogram,
  'assistant-default': AssistantDefaultIcon,
  'assistant-knowledge': AssistantKnowledgeIcon,
  'assistant-task': AssistantTaskIcon,
  question: TriangleQuestionMark
} as const satisfies Record<string, Component>

export type CioIconId = keyof typeof CIO_ICONS
export { type CioGlyphProps, cioStrokeWidth } from '@pdslng/cio-icon'
export { ICON_SIZE, RAIL_ICON_STROKE, type IconSize } from './scale'
