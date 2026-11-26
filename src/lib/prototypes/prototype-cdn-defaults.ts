/**
 * The shipped posture of the prototype CDN setting.
 *
 * This lives apart from `prototype-cdn.ts` for one reason: the renderer's
 * baseline config (`app-defaults.ts`) reads this single flag at boot, and reading
 * it from the full module pulled the whole approved-origin list and the
 * Content-Security-Policy builder onto the first screen, where neither can be
 * used — they are read when a prototype preview is served or when Settings is
 * opened. `prototype-cdn.ts` re-exports the flag, so its public surface is
 * unchanged.
 */

/** Whether a project that has never been configured allows external CDNs. */
export const DEFAULT_PROTOTYPE_CDN_ENABLED = true
