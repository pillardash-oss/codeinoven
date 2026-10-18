import CioActions from '@codeio/icon/CioActions.svelte'
import CioBrowser from '@codeio/icon/CioBrowser.svelte'
import CioCpu from '@codeio/icon/CioCpu.svelte'
import CioImage from '@codeio/icon/CioImage.svelte'
import CioPlug from '@codeio/icon/CioPlug.svelte'
import CioSearch from '@codeio/icon/CioSearch.svelte'
import CioSparkles from '@codeio/icon/CioSparkles.svelte'
import type { Component } from 'svelte'
import type { UtilityKind } from '$shared/types'

/**
 * One glyph per utility kind, shared by the connection rows and the connection
 * picker so a kind always reads the same wherever a connection is shown.
 */
export const UTILITY_KIND_ICONS: Readonly<Record<UtilityKind, Component>> = {
  mcp: CioPlug,
  skill: CioSparkles,
  web_search: CioSearch,
  web_fetch: CioBrowser,
  computer_use: CioActions,
  provider: CioCpu,
  image_descriptor: CioImage
}

const UTILITY_KIND_LABELS: Readonly<Record<UtilityKind, string>> = {
  mcp: 'MCP',
  skill: 'Skill',
  web_search: 'Web search',
  web_fetch: 'Web fetch',
  computer_use: 'Computer use',
  provider: 'Provider',
  image_descriptor: 'Image'
}

/** Display label for a utility kind; a persisted snapshot may name an unknown one. */
export function utilityKindLabel(kind: string | undefined): string {
  if (!kind) return 'Connection'
  return UTILITY_KIND_LABELS[kind as UtilityKind] ?? kind
}

/** Glyph for a utility kind, falling back to the generic connection icon. */
export function utilityKindIcon(kind: string | undefined): Component {
  if (!kind) return CioPlug
  return UTILITY_KIND_ICONS[kind as UtilityKind] ?? CioPlug
}
