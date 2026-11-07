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
