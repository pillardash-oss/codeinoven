import type { PromptAttachment } from '../../../lib/types'
import { resolveFastModelId } from '../../../lib/fast-inference'
import type { SendPromptOptions } from '../driver.interface'
import {
  formatDocumentAsText,
  isDocumentAttachment,
  readDocumentText
} from '../document-attachment'
import { formatSvgAsText, isSvgAttachment, readSvgAttachmentText } from '../svg-attachment'
import { formatTextAsText, isTextAttachment, readTextAttachment } from '../text-attachment'

/** One file attached to a V2 prompt. */
export interface OpenCodeV2PromptFile {
  uri: string
  name?: string
}

/**
 * Convert prompt attachments into V2 prompt files, plus the text blocks that
 * have to be inlined instead.
 *
 * V2 accepts file attachments by URI and the server expands them itself, but
 * its decoder cannot rasterize SVG and some providers reject media types they
 * do not support (e.g. `application/json`). Those attachments are inlined as
 * text, exactly as the V1 driver does, so the model still receives them.
 */
export async function buildOpenCodeV2PromptPayload(
  text: string,
  attachments: readonly PromptAttachment[]
): Promise<{ text: string; files: OpenCodeV2PromptFile[] }> {
  const inlined: string[] = []
  const files: OpenCodeV2PromptFile[] = []
  for (const attachment of attachments) {
    if (isSvgAttachment(attachment)) {
      const content = await readSvgAttachmentText(attachment)
      if (content !== null) {
        inlined.push(formatSvgAsText(attachment, content))
        continue
      }
    }
    if (isTextAttachment(attachment)) {
      const content = await readTextAttachment(attachment)
      if (content !== null) {
        inlined.push(formatTextAsText(attachment, content))
        continue
      }
    }
    if (isDocumentAttachment(attachment)) {
      const content = await readDocumentText(attachment)
      if (content !== null) {
        inlined.push(formatDocumentAsText(attachment, content))
        continue
      }
    }
    files.push({
      uri: attachment.url,
      ...(attachment.filename ? { name: attachment.filename } : {})
    })
  }
  return {
    text: inlined.length > 0 ? [text, ...inlined].join('\n\n') : text,
    files
  }
}

/** One rule in a V2 `Permission.Ruleset`. */
export interface OpenCodeV2PermissionRule {
  action: string
  resource: string
  effect: 'allow' | 'deny' | 'ask'
}

/**
 * Tool actions a turn's allow-list is expressed by denying.
 *
 * Verified live against `opencode v2.0.14`: denying any of these is harmless to
 * the harness, while denying `read` (or a `*` catch-all) makes the model's own
 * provider entitlement check fail with `provider.auth` 403 ("OpenCode's free
 * tier can only be used from within OpenCode")   the harness reads its own
 * credential state through that permission. So `read` is deliberately absent:
 * a v2 turn can restrict everything that mutates, and cannot restrict reading,
 * without breaking the turn entirely.
 */
const RESTRICTABLE_TOOL_ACTIONS = [
  'edit',
  'glob',
  'grep',
  'bash',
  'task',
  'skill',
  'lsp',
  'question',
  'webfetch',
  'websearch',
  'doom_loop'
] as const

/** The same set, exported for the lean-agent config converter. */
export const OPENCODE_V2_RESTRICTABLE_TOOL_ACTIONS = RESTRICTABLE_TOOL_ACTIONS

/** App tool ids that are not V2 permission actions, mapped to the action they use. */
const TOOL_ACTION_ALIASES: Record<string, string> = {
  write: 'edit',
  patch: 'edit',
  // `list` is a read-only v1 tool name; V2 has no action for it and directory
  // listing is covered by `read`, which is never restricted.
  list: 'read'
}

/**
 * Map a thread's permission level onto a V2 permission ruleset.
 *
 * V2 evaluates the ruleset in order with the LAST matching rule winning, so the
 * restrictions come first and the grants after them.
 *
 *  - `full_access` → a single allow-everything rule: nothing is ever asked or
 *    denied, including `external_directory` reads outside the project.
 *  - no allow-list → only `external_directory` is allowed outright (v1's
 *    behavior), so the harness's own defaults apply to every tool.
 *  - an allow-list → every restrictable tool action is denied, then the listed
 *    tools are granted back, then `external_directory` is allowed so an external
 *    read is auto-approved instead of hard-denied before the app's own
 *    permission card can approve it. `read` can never be part of the
 *    restriction (see {@link RESTRICTABLE_TOOL_ACTIONS}).
 */
export function buildOpenCodeV2PermissionRuleset(
  opts: Pick<SendPromptOptions, 'settings' | 'allowedTools'>
): OpenCodeV2PermissionRule[] {
  if (opts.settings.permissionLevel === 'full_access') {
    return [{ action: '*', resource: '*', effect: 'allow' }]
  }
  const rules: OpenCodeV2PermissionRule[] = []
  if (opts.allowedTools === undefined) {
    rules.push({ action: 'external_directory', resource: '*', effect: 'allow' })
    return rules
  }
  for (const action of RESTRICTABLE_TOOL_ACTIONS) {
    rules.push({ action, resource: '*', effect: 'deny' })
  }
  for (const tool of opts.allowedTools) {
    const action = TOOL_ACTION_ALIASES[tool.toLowerCase()] ?? tool
    // `read` and its alias are already permitted by omission from the deny set.
    if (action === 'read') continue
    rules.push({ action, resource: '*', effect: 'allow' })
  }
  rules.push({ action: 'external_directory', resource: '*', effect: 'allow' })
  return rules
}

/** The model reference a V2 session and prompt use. */
export interface OpenCodeV2ModelRef {
  id: string
  providerID: string
  variant?: string
}

/** Build the `Model.Ref` a V2 session is switched to for one turn. */
export function buildOpenCodeV2ModelRef(
  opts: Pick<SendPromptOptions, 'settings'>
): OpenCodeV2ModelRef | undefined {
  const modelId = resolveFastModelId(opts.settings.modelId, opts.settings.inferenceMode)
  if (!opts.settings.providerId || !modelId) return undefined
  return {
    id: modelId,
    providerID: opts.settings.providerId,
    // V2 selects the model variant by id, and the app's thinking levels are the
    // variant ids its own config injects for reasoning models.
    ...(opts.settings.thinkingLevel ? { variant: opts.settings.thinkingLevel } : {})
  }
}

/**
 * Wrap an app-managed system prompt so the model reads it as harness context
 * rather than as something the user typed.
 *
 * V2's prompt body has no `system` field; the only channel the API exposes for
 * context that is not a user turn is a synthetic inbox item, and this is the
 * text that goes in it.
 */
export function wrapOpenCodeV2SystemContext(systemPrompt: string): string {
  return `[System instructions for this session]\n\n${systemPrompt}`
}

/**
 * The V2 prompt body for one turn.
 *
 * V2 takes the turn's text and files only: the model, the agent, and the
 * permission ruleset are session-scoped and are applied separately before the
 * prompt is admitted.
 */
export function buildOpenCodeV2PromptBody(payload: {
  text: string
  files: readonly OpenCodeV2PromptFile[]
  userMessageId?: string
  delivery?: 'steer' | 'queue'
}): Record<string, unknown> {
  return {
    ...(payload.userMessageId ? { id: payload.userMessageId } : {}),
    text: payload.text,
    ...(payload.files.length > 0 ? { files: payload.files } : {}),
    delivery: payload.delivery ?? 'steer'
  }
}

/**
 * The V2 body for the synthetic inbox item that carries the turn's system
 * prompt.
 *
 * `resume: false` parks it in the inbox so the immediately following prompt
 * starts the loop and drains both items in order; admitting it with `resume:
 * true` would start a loop on the system prompt alone.
 */
export function buildOpenCodeV2SyntheticBody(text: string): Record<string, unknown> {
  return { text, resume: false }
}
