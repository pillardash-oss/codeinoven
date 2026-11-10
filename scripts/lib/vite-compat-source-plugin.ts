/**
 * Vite plugin for `?compat-source` imports.
 *
 * A browser-extension shim (`src/main/browser/extensions/compat/*.ts`) is authored
 * as TypeScript and injected at run time as text, so it is imported through this
 * query instead of `?raw`. The query is what makes the file visible to
 * `bun run check`, to the linter and to the 2000-line ceiling: `?raw` hands the
 * bundler the file's bytes and nothing else ever reads it.
 *
 * The plugin compiles the file through {@link compileCompatSource} and exports the
 * result as a single string, so a caller keeps the shape it had with `?raw`:
 * `import pageTabsSource from './compat/cio-page-tabs.ts?compat-source'`.
 *
 * It is `enforce: 'pre'` so it runs before any transform would try to treat the
 * shim as part of the app's own module graph.
 */
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import type { Plugin } from 'vite'
import { COMPAT_SOURCE_QUERY, compileCompatSource } from './compat-source-compiler.ts'

export function compatSourcePlugin(): Plugin {
  // Vite is started from the project root by electron-vite, and the banner wants a
  // project-relative path: the main environment's own `root` is `src/main`, which
  // would produce `../browser/...` for every shim.
  const projectRoot = process.cwd()

  return {
    name: 'codeinoven:compat-source',
    enforce: 'pre',
    async load(id) {
      const queryStart = id.indexOf('?')
      if (queryStart === -1) return null
      const parameters = id.slice(queryStart + 1).split('&')
      if (!parameters.includes(COMPAT_SOURCE_QUERY)) return null

      const filePath = id.slice(0, queryStart)
      const source = await readFile(filePath, 'utf8')

      // The build has to rebuild when a shim changes, and nothing else in the
      // module graph points at the file once the raw bytes are no longer imported.
      this.addWatchFile(filePath)

      const compiled = compileCompatSource(source, {
        sourcePath: relative(projectRoot, filePath).split('\\').join('/')
      })
      return `export default ${JSON.stringify(compiled)}`
    }
  }
}
