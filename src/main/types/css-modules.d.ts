/**
 * A stylesheet imported for its side effect.
 *
 * Vite resolves these imports and bundles the CSS; TypeScript has no types for
 * them, so without this declaration a `import './x.css'` line is an error in
 * every renderer entry that loads a stylesheet (the app window and the toast
 * overlay both do).
 *
 * It lives in `src/main/types/` because that folder is included by every scoped
 * check `scripts/check.ts` runs, which is the only way an ambient declaration
 * reaches a check that names its files one by one.
 */
declare module '*.css'
