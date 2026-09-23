import { SvelteMap } from 'svelte/reactivity'
import { spaceOutProjectReferences } from '../chats/composer-mentions'
import { getVendorIconSvg } from '$lib/vendor-icons/registry'
import { APP_NAME } from '$shared/brand'
import { getAgentIcon } from '$lib/agent-icons/registry'
import { fastBaseModelId, fastVariantForModelId } from '$shared/fast-inference'
import { resolveDefaultThinkingLevel } from '$shared/thinking-presets'
import { generatedTokens, type LiveGenerationRate } from '$lib/token-rate.svelte'
import type {
  AgentMessage,
  AgentPart,
  PromptProjectReference,
  ProviderCatalog,
  ProviderModel,
  SpecActionIntent,
  ThinkingLevel,
  UserMessagePresentation
} from '$shared/types'

/**
 * How a single message is described in the transcript: its display text, the
 * inline chips for its tagged references, the work-trace preview used by the
 * history side panel, and its model/harness/token attribution.
 *
 * Catalogs and live rate state are supplied by the caller, so every rule here
 * is a pure function of a message plus the data needed to describe it.
 */

/** Extract display text only; transport instructions never enter `parts`. */
export function rawMessageText(msg: AgentMessage): string {
  return msg.parts
    .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

export function explicitMessagePresentation(msg: AgentMessage): UserMessagePresentation | null {
  const part = msg.parts.find(
    (candidate): candidate is Extract<AgentPart, { type: 'user-presentation' }> =>
      candidate.type === 'user-presentation'
  )
  return part?.presentation ?? null
}

export function specActionLabel(action: SpecActionIntent): string {
  if (action === 'request') return 'Spec requested'
  return action === 'implement' ? 'Implement spec' : 'Review spec'
}

/** Return only content stored in the durable display parts. */
export function messageText(msg: AgentMessage): string {
  const text = rawMessageText(msg)
  const explicit = explicitMessagePresentation(msg)
  if (explicit) return [explicit.action, explicit.body].filter(Boolean).join('\n\n')
  // Restore the separator a tagged path lost when it was glued to the next
  // word, so already-sent messages read with a clean space before the chip.
  return msg.projectReferences?.length
    ? spaceOutProjectReferences(text, msg.projectReferences)
    : text
}

/**
 * Short work-trace snippets per user message, used as tree children in the
 * history side panel: up to three labels from the turn that follows the
 * message (its assistant reply), stopping at the next user message.
 */
export function tracePreviewByUserMessage(entries: AgentMessage[]): SvelteMap<string, string[]> {
  const TRACE_PREVIEW_LIMIT = 3
  const SNIPPET_LIMIT = 80
  const previews = new SvelteMap<string, string[]>()
  let currentUser: string | null = null
  let snippets: string[] = []
  const push = (snippet: string): void => {
    if (currentUser === null || snippets.length >= TRACE_PREVIEW_LIMIT) return
    const line = snippet.trim().split('\n', 1)[0] ?? ''
    if (line.length === 0) return
    snippets.push(line.length > SNIPPET_LIMIT ? `${line.slice(0, SNIPPET_LIMIT)}…` : line)
  }
  const flush = (): void => {
    if (currentUser !== null && snippets.length > 0) previews.set(currentUser, snippets)
    currentUser = null
    snippets = []
  }
  for (const message of entries) {
    if (message.role === 'user') {
      flush()
      currentUser = message.id
      continue
    }
    if (currentUser === null) continue
    for (const part of message.parts) {
      if (part.type === 'tool') push(part.tool)
      else if (part.type === 'reasoning') push(part.summary ?? part.text)
      else if (part.type === 'subagent') push(part.activity.description)
    }
  }
  flush()
  return previews
}

function escapeHtmlForChip(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function inlineChipHtml(reference: PromptProjectReference): string {
  const safeName = escapeHtmlForChip(reference.name)
  const safePath = escapeHtmlForChip(reference.path)
  const safeTitle = escapeHtmlForChip(
    `Tagged ${reference.kind}: ${reference.name}, ${reference.path}`
  )
  const icon =
    reference.kind === 'directory'
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 4a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4z"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
  return `<span class="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-elevated px-1.5 py-0.5 text-[0.75rem] leading-none align-baseline" title="${safeTitle}" data-file-chip="${safePath}">${icon}<span class="max-w-48 truncate font-medium">${safeName}</span></span>`
}

function inlineUtilityChipHtml(): string {
  // Inline SVG (not an `<img>` data URI) so the icon's embedded `.dark`
  // selector can see the theme class on `<html>`: the mark's ink follows the
  // active theme (black on light, white on dark). The chip's
  // `text-[0.75rem]` sets the em box the 1em-sized SVG scales into.
  const icon = getVendorIconSvg(APP_NAME)
  const safeTitle = escapeHtmlForChip(`${APP_NAME} utility`)
  const iconHtml = icon
    ? `<span class="inline-flex shrink-0 text-[0.75rem] leading-none" aria-hidden="true">${icon}</span>`
    : ''
  return `<span class="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-elevated px-1.5 py-0.5 text-[0.75rem] leading-none align-baseline" title="${safeTitle}" data-utility-chip="cio-utility">${iconHtml}<span class="max-w-48 truncate font-medium">utility</span></span>`
}

export function inlineFileTagsForMessage(
  msg: AgentMessage
): Array<{ token: string; html: string }> {
  const text = messageText(msg)
  const tags: Array<{ token: string; html: string }> = []
  // The `@cio-utility` tag renders as a badge on the conversation screen too,
  // mirroring the composer badge for the same token.
  if (text.includes('@cio-utility')) {
    tags.push({ token: '@cio-utility', html: inlineUtilityChipHtml() })
  }
  if (!msg.projectReferences?.length) return tags
  // Only inline references that actually appear as `@path` in the stored text;
  // remaining references will still render as the legacy top pills so no tag
  // is lost. Longest paths first prevents a parent directory token from
  // swallowing the prefix of a longer child path.
  const ordered = [...msg.projectReferences].sort((a, b) => b.path.length - a.path.length)
  for (const reference of ordered) {
    const token = `@${reference.path}`
    if (!token || !text.includes(token)) continue
    tags.push({ token, html: inlineChipHtml(reference) })
  }
  return tags
}

/** Provider catalog entry the message was answered through, when known. */
export function messageProvider(
  msg: AgentMessage,
  providers: readonly ProviderCatalog[]
): ProviderCatalog | undefined {
  if (msg.providerId) {
    const direct = providers.find((p) => p.id === msg.providerId)
    if (direct) return direct
  }
  if (!msg.modelId) return undefined
  return providers.find((p) => p.models.some((m) => m.id === msg.modelId))
}

/** Human model name: catalog display name, else the raw model id. */
export function messageModelLabel(
  msg: AgentMessage,
  allModels: readonly ProviderModel[]
): string | null {
  if (!msg.modelId) return null
  const model =
    allModels.find(
      (m) => m.id === msg.modelId && (!msg.providerId || m.providerId === msg.providerId)
    ) ?? allModels.find((m) => m.id === msg.modelId)
  if (model) return model.name
  // Fast variants may be absent from harness catalogs: fall back to a derived label.
  return fastVariantForModelId(msg.modelId)?.label ?? msg.modelId
}

/** Harness that produced the message, given the thread's harness fallback. */
export function resolveMessageHarnessId(msg: AgentMessage, fallbackHarnessId: string): string {
  return msg.harnessId ?? fallbackHarnessId
}

/** Display name for the harness that produced a message. */
export function messageHarnessName(msg: AgentMessage, fallbackHarnessId: string): string {
  const id = resolveMessageHarnessId(msg, fallbackHarnessId)
  return getAgentIcon(id)?.name ?? id
}

/**
 * Display name for a harness id in operator-facing copy.
 *
 * Kept separate from {@link messageHarnessName} on purpose: this is the short
 * product name used in status copy, while the message attribution prefers the
 * agent registry's own label.
 */
export function harnessDisplayName(harnessId: string): string {
  if (harnessId === 'opencode') return 'OpenCode'
  if (harnessId === 'opencode2') return 'OpenCode V2'
  if (harnessId === 'claude-code') return 'Claude Code'
  if (harnessId === 'codex') return 'Codex'
  if (harnessId === 'cline') return 'Cline'
  if (harnessId === 'pi') return 'Pi'
  if (harnessId === 'antigravity') return 'Antigravity'
  return harnessId
}

export interface MessageTokenRateSource {
  finalizedTokenRates: Record<string, number>
  liveTokenRate: LiveGenerationRate
}

/** Generation rate (tok/s) to show for a completed message: the rate finalized
 *  at turn end when this view observed the turn live, otherwise the message's
 *  generated tokens over its accumulated model-active generation window.
 *
 *  `generationMs` is the only honest denominator: it sums the streaming time of
 *  every request in the message and excludes tool waits. A message whose
 *  generation window was never recorded shows no rate rather than dividing its
 *  tokens by wall-clock time, which counts tool execution as generation.
 *  `null` also when the harness reported no tokens. */
export function messageTokenRate(msg: AgentMessage, source: MessageTokenRateSource): number | null {
  const finalized = source.finalizedTokenRates[msg.id]
  if (finalized !== undefined && finalized > 0) return finalized
  const generated = generatedTokens(msg.tokens)
  if (generated <= 0) return null
  if (msg.id === source.liveTokenRate.messageId) return source.liveTokenRate.rate()
  if (msg.generationMs !== undefined && msg.generationMs > 0) {
    return generated / (msg.generationMs / 1000)
  }
  return null
}

/** Thinking level used for the message's turn, when its model reasons. */
export function messageThinkingLevel(
  msg: AgentMessage,
  allModels: readonly ProviderModel[]
): ThinkingLevel | null {
  if (!msg.modelId) return null
  const modelId = fastBaseModelId(msg.modelId)
  const model =
    allModels.find(
      (m) => m.id === modelId && (!msg.providerId || m.providerId === msg.providerId)
    ) ?? allModels.find((m) => m.id === modelId)
  const presets = model?.thinkingPresets ?? []
  // A model known not to reason never shows a thinking badge, even when a
  // generic level was stamped onto its rows.
  if (model && presets.length === 0) return null
  // Prefer the level actually persisted for this turn (historical truth),
  // falling back to the model's own default. Never fall back to the live
  // composer settings here: a finished message's badge must not mutate when
  // the user changes the thinking level mid-conversation.
  if (msg.thinkingLevel) return msg.thinkingLevel
  if (presets.length === 0) return null
  return resolveDefaultThinkingLevel(presets, undefined) ?? null
}
