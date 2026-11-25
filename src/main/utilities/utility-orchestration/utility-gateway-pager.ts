import { createHash, randomUUID } from 'node:crypto'
import { GATEWAY_TEXT_CHARACTER_LIMIT } from './utility-gateway-output'

/**
 * Paging for a tool result larger than the character budget.
 *
 * The budget used to answer an oversized result by cutting it and pointing at a
 * file, which is a dead end for an agent that cannot or should not read files:
 * the contract it asked for arrives as a fraction of itself, and the fraction is
 * the head and the tail. A pager answers the same call the way a reader would:
 * page 1 of N, how much arrived, how much is left, and one reference that fetches
 * the next page without running the tool again.
 *
 * Two things make that safe. The full text is held for the turn, so page 2 is a
 * read rather than a second dispatch, which is what stops a `preview`,
 * `checkpoint` or any other mutation from running twice. And the page size is the
 * caller's to raise for one call, because a tool whose whole answer an agent
 * genuinely needs (a capability's contract, a design's operations) should be
 * gettable in one round trip rather than in six.
 */

/** Smallest page a caller may ask for. Below this the header costs the answer. */
export const GATEWAY_PAGE_MIN_CHARACTERS = 2_000

/**
 * Largest page a caller may ask for.
 *
 * A page is context the next model call pays for, so the ceiling is generous
 * rather than unlimited: it fits the largest contract this app hands out (a
 * capability playbook plus its operation catalog) with room to spare, and a
 * caller that needs more than this is reading a payload it should filter.
 */
export const GATEWAY_PAGE_MAX_CHARACTERS = 200_000

/** Pages one call may ask for. A page beyond the payload is answered empty. */
export const GATEWAY_PAGE_MAX_NUMBER = 6_400

/** Documents the app keeps. A session that reads twenty-five large payloads is
 *  not paging its way back through the first; the ones it has moved past go. */
const MAX_HELD_DOCUMENTS = 24

/** Characters kept across every held document. */
const MAX_HELD_CHARACTERS = 2_000_000

export interface GatewayPageRequest {
  /** One-based page of the payload. */
  page: number
  /** Characters one page carries, the caller's override of the budget default. */
  charSize: number
  /** The document a page is read from, absent on the call that produces it. */
  pageRef: string | null
}

/** What one page carries, and what the caller still has to fetch. */
export interface GatewayPage {
  page: number
  pages: number
  charSize: number
  charGotten: number
  charLeft: number
}

const PAGE_FIELDS = ['page', 'charSize', 'pageRef'] as const

function integerField(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be a whole number from ${minimum} to ${maximum}`)
  }
  return value
}

export function withoutPageFields(input: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!(PAGE_FIELDS as readonly string[]).includes(key)) rest[key] = value
  }
  return rest
}

/**
 * The pager fields a call carried, and the same call without them.
 *
 * Stripped rather than forwarded: these are the gateway's own fields, and a
 * utility receiving `page` in its `input` would be handed an argument its schema
 * never declared. The caller's object is left untouched.
 */
export function readPageRequest(input: Record<string, unknown>): {
  request: GatewayPageRequest
  rest: Record<string, unknown>
} {
  const page = integerField(input['page'], 'page', 1, GATEWAY_PAGE_MAX_NUMBER) ?? 1
  const charSize =
    integerField(
      input['charSize'],
      'charSize',
      GATEWAY_PAGE_MIN_CHARACTERS,
      GATEWAY_PAGE_MAX_CHARACTERS
    ) ?? GATEWAY_TEXT_CHARACTER_LIMIT
  const rawReference = input['pageRef']
  if (
    rawReference !== undefined &&
    (typeof rawReference !== 'string' || rawReference === '' || rawReference.length > 128)
  ) {
    throw new TypeError('pageRef must be a reference returned by an earlier page')
  }
  if (page > 1 && rawReference === undefined) {
    throw new TypeError(
      'Reading a later page needs the pageRef the first page returned, so the tool does not run a second time'
    )
  }
  const rest = withoutPageFields(input)
  return { request: { page, charSize, pageRef: rawReference ?? null }, rest }
}

/** A held payload, with the call that produced it so its pages stay attributable. */
export interface HeldPage {
  tool: string
  text: string
}

/**
 * The payloads held for paging, by thread, least recently read last.
 *
 * Held for the thread rather than for the turn that produced them, because the
 * reason a later page is wanted is usually that time has passed: a contract read
 * at the start of a session is still the contract the fifth message wants the rest
 * of, and a turn-scoped payload would make every page reference die exactly when
 * it became useful. A reference names its thread and is refused in another one.
 *
 * Bounded twice, by document count and by total characters, because a held
 * payload is live main-process memory: past the ceiling the least recently read
 * document is given back, and a reference to it answers with the same sentence a
 * missing one does. It survives turn boundaries and not the app, which is the
 * honest lifetime for something rebuilt by one call.
 */
export class GatewayPageStore {
  private readonly held = new Map<string, HeldPage & { threadId: string }>()
  private characters = 0

  hold(threadId: string, tool: string, text: string): string {
    const ref = `pg-${hashThreadId(threadId)}-${randomUUID().slice(0, 8)}`
    this.held.set(ref, { threadId, tool, text })
    this.characters += text.length
    this.evict()
    return ref
  }

  /** One held payload, refused unless it was held for the thread asking. */
  read(threadId: string, ref: string): HeldPage | null {
    const held = this.held.get(ref)
    if (!held || held.threadId !== threadId) return null
    // A payload read again is a payload in use, so it moves to the young end.
    this.held.delete(ref)
    this.held.set(ref, held)
    return { tool: held.tool, text: held.text }
  }

  clear(): void {
    this.held.clear()
    this.characters = 0
  }

  private evict(): void {
    while (
      this.held.size > MAX_HELD_DOCUMENTS ||
      (this.characters > MAX_HELD_CHARACTERS && this.held.size > 1)
    ) {
      const oldest = this.held.keys().next()
      if (oldest.done) return
      const entry = this.held.get(oldest.value)
      this.held.delete(oldest.value)
      this.characters -= entry?.text.length ?? 0
    }
  }
}

/** The thread a reference belongs to, short enough to read in a header. */
function hashThreadId(threadId: string): string {
  return createHash('sha1').update(threadId).digest('hex').slice(0, 8)
}

/** Room a page leaves for its own header, so the part stays inside the budget. */
const PAGE_HEADER_RESERVE = 400

/** One page of a text, and the numbers that describe it. */
export function readPage(
  text: string,
  request: GatewayPageRequest,
  reserve = PAGE_HEADER_RESERVE
): GatewayPage & { text: string } {
  // The header travels in the same text part as the page, so the page gives it
  // room: a part a few hundred characters over the budget is a part the budget
  // would shorten, and the caller would be handed a truncated page of a payload
  // it was told it could read in full.
  const size = Math.max(1, request.charSize - reserve)
  const pages = Math.max(1, Math.ceil(text.length / size))
  const start = (request.page - 1) * size
  const window = text.slice(start, start + size)
  return {
    page: request.page,
    pages,
    charSize: request.charSize,
    charGotten: window.length,
    charLeft: Math.max(0, text.length - start - window.length),
    text: window
  }
}

/** Whether a value is a JSON object, without importing a helper for one line. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A shaped gateway result, paged when its text is larger than one page.
 *
 * The parts that carry text are read as one document, because a page is a slice
 * of what the call answered rather than of one part of it. Every other part (an
 * image, a picture the tool returned) is kept whole beside the page, since bytes
 * cannot be cut. A result that already fits is returned untouched, so the common
 * case keeps the per-unit shape and pays no header.
 */
export function pageOversizedResult(
  shaped: unknown,
  threadId: string,
  tool: string,
  request: GatewayPageRequest,
  store: GatewayPageStore
): unknown {
  if (!isRecord(shaped) || !Array.isArray(shaped['content'])) return shaped
  const texts: string[] = []
  const others: unknown[] = []
  for (const part of shaped['content']) {
    if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') {
      texts.push(part['text'])
      continue
    }
    others.push(part)
  }
  const whole = texts.join('\n')
  if (whole.length <= request.charSize) return shaped
  const pageRef = store.hold(threadId, tool, whole)
  const page = readPage(whole, request)
  const structured = isRecord(shaped['structuredContent'])
  return {
    content: [
      { type: 'text', text: `${pageHeader(tool, page, pageRef, structured)}\n${page.text}` },
      ...others
    ],
    ...(structured ? { structuredContent: shaped['structuredContent'] } : {})
  }
}

/**
 * One page of a payload the turn is already holding.
 *
 * Nothing is dispatched, so this answers a page request for a call that must not
 * run twice. The structured payload is not repeated: a script read it from the
 * first response, which is also why the header stops claiming one.
 */
export function heldPageResult(held: HeldPage, request: GatewayPageRequest): unknown {
  const page = readPage(held.text, request)
  return {
    content: [
      {
        type: 'text',
        text: `${pageHeader(held.tool, page, request.pageRef ?? '', false)}\n${page.text}`
      }
    ]
  }
}

/**
 * The line a paged answer opens with.
 *
 * It names the call the text came from, the page and how many there are, the page
 * size in force, what arrived, what is left, and the reference that fetches the
 * rest. One JSON object on its own line, so a model reads it without parsing it
 * and a log stays readable.
 */
export function pageHeader(
  tool: string,
  page: GatewayPage,
  pageRef: string,
  structured: boolean
): string {
  const header: Record<string, unknown> = {
    tool,
    page: page.page,
    pages: page.pages,
    charSize: page.charSize,
    charGotten: page.charGotten,
    charLeft: page.charLeft,
    pageRef
  }
  if (page.charLeft > 0) {
    // The page size that returns the whole payload in one call, which is what a
    // caller wanting the whole contract should ask for instead of paging through
    // it: the offset already read, this page, and what is left.
    const whole = Math.min(
      GATEWAY_PAGE_MAX_CHARACTERS,
      (page.page - 1) * page.charSize + page.charGotten + page.charLeft
    )
    header['next'] =
      page.page < page.pages
        ? `Page ${page.page + 1} of ${page.pages}: call this tool again with {pageRef:"${pageRef}", page:${page.page + 1}}, or with {pageRef:"${pageRef}", page:1, charSize:${whole}} to read the whole payload in one call`
        : `The last page. Call again with {pageRef:"${pageRef}", page:1, charSize:${whole}} to read the whole payload in one call`
  }
  if (structured)
    header['structured'] = 'The full result is in structuredContent; code mode reads it there.'
  return JSON.stringify(header) ?? ''
}
