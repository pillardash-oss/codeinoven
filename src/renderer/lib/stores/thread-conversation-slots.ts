/**
 * How many conversations stay resident at once.
 *
 * A transcript is the most expensive thing this window holds: a long
 * conversation is megabytes of message objects, parts and markdown source, and
 * every one of them survives a GC because something in a store points at it. The
 * cache used to keep eight of them and to evict by last *touch* rather than by
 * last open, so a burst of streaming events in threads nobody had opened could
 * push out the conversation actually on screen.
 *
 * The policy here is the one the reader can predict: the three conversations
 * opened most recently stay, the fourth pushes the oldest out. Everything else
 * is re-read from the mirror as a bounded page when it is opened again, and the
 * frozen screen that is already painted over the pane covers that read.
 */
export const CONVERSATION_SLOTS = 3

/** One thread's place in the open stack. */
type SlotKey = string

/**
 * The open stack after `key` is opened.
 *
 * Oldest first, so the tail is the conversation the reader is in. Re-opening a
 * conversation that is already in the stack moves it to the tail instead of
 * appearing twice, which is what makes "the last three opened" a set and not a
 * history.
 */
export function pushOpenedSlot(openOrder: readonly SlotKey[], key: SlotKey): SlotKey[] {
  const without = openOrder.filter((candidate) => candidate !== key)
  without.push(key)
  return without
}

/** What a slot pass keeps resident and what it drops. */
export interface SlotPlan {
  /** The open order to keep, oldest first. */
  openOrder: SlotKey[]
  /** The keys whose transcripts stay in memory. */
  retained: SlotKey[]
  /** The keys to drop, in the order they were opened. */
  evicted: SlotKey[]
}

/**
 * Decide which resident transcripts survive an open.
 *
 * `held` are the keys that cannot be dropped whatever the stack says: a
 * conversation with a mounted reader, a load in flight, or a batched reveal
 * still painting. Holding one does not buy it a slot, so a conversation someone
 * is genuinely looking at is protected while the stack keeps its own order.
 */
export function planSlots(input: {
  openOrder: readonly SlotKey[]
  resident: readonly SlotKey[]
  held: readonly SlotKey[]
  slots?: number
}): SlotPlan {
  const slots = Math.max(1, input.slots ?? CONVERSATION_SLOTS)
  const openOrder = [...input.openOrder]
  const inStack = new Set(openOrder.slice(-slots))
  const held = new Set(input.held)
  const retained = input.resident.filter((key) => inStack.has(key) || held.has(key))
  const kept = new Set(retained)
  const evicted = input.resident.filter((key) => !kept.has(key))
  // A slot the stack remembers but the cache no longer holds costs nothing to
  // forget, and keeping it would make a later open look like a re-open.
  return { openOrder: openOrder.filter((key) => kept.has(key)), retained, evicted }
}
