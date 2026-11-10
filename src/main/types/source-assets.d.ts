/**
 * A source file imported as text.
 *
 * A few main-process features ship source with the app and compile or evaluate it
 * at run time, so they import the file through Vite's `?raw` query. TypeScript has
 * no types for that query, and without this declaration the import is an error for
 * every scoped check that names the importing file on its own.
 */
declare module '*?raw' {
  const source: string
  export default source
}

/**
 * An injected browser-extension shim, as the text the app writes into an
 * extension.
 *
 * The files in `src/main/browser/extensions/compat/` are not modules this app
 * bundles: each is injected into an extension's own page, content world or
 * service worker and executed there. They are authored as `.ts` so they are
 * type-checked like every other source file in the repository, and this query
 * compiles one to plain JavaScript at build time (see
 * `scripts/lib/compat-source-compiler.ts`). A shim reached through `?raw` is
 * unchecked by definition, so new shims use this query and never `?raw`.
 */
declare module '*?compat-source' {
  const source: string
  export default source
}
