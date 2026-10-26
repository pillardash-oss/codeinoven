/**
 * The turn that describes a visual asset instead of producing one.
 *
 * An assistant thread asked for a personal-brand logo once answered with "I've
 * made the first logo direction as a clean SVG wordmark, ... The full name sits
 * beneath it" and delivered nothing: no file, no render call, no artifact
 * message. Prose that describes an asset is indistinguishable from prose that
 * reports a real one, so the engine never reads the answer to decide this. It
 * reads the side that cannot lie, the user's own request, and the one signal the
 * app owns, whether an artifact was rendered in the turn.
 *
 * Detection is deliberately narrow, in the spirit of `not-available-detector.ts`:
 * a creation verb and a visual deliverable noun in that order, close together,
 * with no negation in front. A conversation about a logo ("what makes a good
 * logo?") therefore cannot trigger it, and the correction round costs one turn
 * at most because the engine never nudges twice.
 */

import { UTILITY_INVOKE_TOOL_NAME } from '$shared/gateway-tools'

/** A requested asset a conversation can hold as a rendered artifact. */
const VISUAL_DELIVERABLE =
  /\b(?:logo|logotype|wordmark|monogram|emblem|crest|favicon|icon|badge|illustration|artwork|poster|banner|avatar|mascot|sticker|wallpaper|thumbnail|brand\s+mark|graphic|vector(?:\s+art)?|svg|wireframe|mockup|mock-up)\b/iu

/**
 * A verb a request uses when it asks for the asset to exist.
 *
 * Only request-shaped forms are listed: a base form, a gerund or a past
 * participle. Third-person "makes" is excluded on purpose, because "what makes a
 * good logo?" is a question about logos, not a request for one, and that single
 * form was the only false positive in the failure that motivated this guard.
 */
const CREATION_VERB =
  /\b(?:design(?:ing|ed)?|creat(?:e|ing|ed)|mak(?:e|ing)|generat(?:e|ing|ed)|draw(?:ing|n)?|produc(?:e|ing|ed)|sketch(?:ing|ed)?|draft(?:ing|ed)?|build(?:ing)?|render(?:ing|ed)?|craft(?:ing|ed)?|vectoriz(?:e|ing|ed)|customiz(?:e|ing|ed)|refresh(?:ing|ed)?|come\s+up\s+with)\b/iu

/** A negation in front of the verb means the user asked for the opposite. */
const NEGATED_REQUEST = /\b(?:don't|do\s+not|never|no\s+need\s+to|without)\s+(?:\w+\s+){0,3}$/iu

/** How far a noun may follow its verb and still belong to it. */
const MAX_REQUEST_SPAN = 140

export interface VisualDeliverableRequest {
  /** The deliverable noun the request named, used to build the steering prompt. */
  noun: string
}

/**
 * Read a user turn as a request for a visual deliverable.
 *
 * Returns the requested noun only when a creation verb and a visual noun appear
 * in that order inside one clause-sized span, so an imperative request ("design
 * a logo for my brand", "we are designing a logo") matches and a discussion or a
 * negated mention ("don't make a logo", "the logo you designed") does not.
 */
export function visualDeliverableRequest(text: string): VisualDeliverableRequest | null {
  const source = text.trim()
  if (!source) return null
  const verb = CREATION_VERB.exec(source)
  if (!verb) return null
  const verbStart = verb.index
  const beforeVerb = source.slice(Math.max(0, verbStart - 40), verbStart)
  if (NEGATED_REQUEST.test(beforeVerb)) return null
  const window = source.slice(verbStart, verbStart + MAX_REQUEST_SPAN)
  const noun = VISUAL_DELIVERABLE.exec(window)
  if (!noun || noun.index <= 0) return null
  return { noun: noun[0].toLowerCase() }
}

/**
 * The one correction round for a visual request that produced no artifact.
 *
 * It names the failure plainly, gives the authoring path for vector work (the
 * asset a logo actually is), names the exact render invocation, and forbids the
 * behaviour that started this guard: claiming a deliverable that does not exist.
 * It also forbids hunting an image generator for vector work, which is how the
 * original turn drifted into an installation card.
 */
export function visualDeliverableRepairPrompt(request: VisualDeliverableRequest): string {
  return [
    `This turn asked for a ${request.noun} and no artifact was rendered: the turn produced no file and never called the artifact render operation.`,
    'A description of an asset is not the asset. Never state or imply that an asset exists unless you wrote the file and the render operation accepted it.',
    'Do the work now with your own tools. Author vector work (logo, wordmark, monogram, icon, emblem, badge, poster, graphic) yourself as a complete self-contained SVG in your workspace, and use HTML for a page or layout; both must stay smaller than 64000 bytes.',
    `Then deliver it: ${UTILITY_INVOKE_TOOL_NAME} with utility_id "cio:artifact", operation "render", input { "path": "<the file you wrote>" }. Render each asset you produced, in the order you would present it.`,
    'You can author SVG directly: do not search for or install an image generator to draw vector work, and do not offer an installation card for it.',
    'If the request genuinely needs something you do not have, ask for exactly that and say what you will build.'
  ].join(' ')
}
