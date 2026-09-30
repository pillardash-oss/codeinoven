/**
 * How many extensions may be pinned into the app header at once.
 *
 * A pin is a place in the app's own chrome, not in a browser surface, and the
 * header has room for a handful before the pins stop reading as shortcuts and
 * start reading as a second list. The extensions panel is that list, so past this
 * many the panel is where an extension is found and the header stays quiet.
 *
 * Pure data, shared by main (which enforces the cap on every write) and the
 * renderer (which explains the limit before a click can fail).
 */
export const MAX_PINNED_EXTENSIONS = 5
