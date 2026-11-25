/**
 * What an agent may do to a page.
 *
 * A browser tab's assistant conversation answers about the page on screen, so its
 * browser capability is attached to that tab. Reading operations observe it;
 * mutations act on it. Nothing is gated: the sets are here because the service
 * and the callers have to agree on which operations read and which act.
 */

/**
 * The browser operations that only observe a page.
 */
export const ATTACHED_PAGE_READ_OPERATIONS = new Set([
  'snapshot',
  'screenshot',
  'console',
  'wait',
  'query'
])

/**
 * The browser operations that act on a page.
 *
 * Upload still uses a native file chooser or exact-file confirmation, because that
 * decides which local file the page may read rather than anything the page does.
 */
export const ATTACHED_PAGE_MUTATION_OPERATIONS = new Set([
  'click',
  'type',
  'press',
  'select',
  'check',
  'mouse',
  'drag',
  'scroll',
  'navigate',
  'reload',
  'viewport',
  'upload',
  'evaluate',
  'run'
])
