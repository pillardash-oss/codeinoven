/**
 * Vite plugin for `?compat-source` and `?compat-bundle` imports.
 *
 * A browser-extension shim (`src/main/browser/extensions/compat/*.ts`) is authored
 * as TypeScript and injected at run time as text, so it is imported through one of
 * these queries instead of `?raw`. The query is what makes the file visible to
 * `bun run check`, to the linter and to the 2000-line ceiling: `?raw` hands the
 * bundler the file's bytes and nothing else ever reads it.
 *
 *   - `?compat-source` compiles ONE self-contained shim: types stripped, no module
 *     boundary allowed. A caller keeps the shape it had with `?raw`.
 *   - `?compat-bundle` bundles an entry module and the modules it imports into one
 *     IIFE, for a shim that has grown past a single file and is split by concern.
 *
 * Both are resolved here, and this plugin is `enforce: 'pre'` so it runs before any
 * transform would try to treat a shim as part of the app's own module graph.
 */
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import type { Plugin } from 'vite'
import {
  COMPAT_BUNDLE_QUERY,
  COMPAT_SOURCE_QUERY,
  bundleCompatSource,
  compileCompatSource
} from './compat-source-compiler.ts'

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
      const isBundle = parameters.includes(COMPAT_BUNDLE_QUERY)
      if (!isBundle && !parameters.includes(COMPAT_SOURCE_QUERY)) return null

      const filePath = id.slice(0, queryStart)
      // The build has to rebuild when a shim changes, and nothing else in the
      // module graph points at the file once the raw bytes are no longer imported.
      // A bundle also depends on every module it imports, which esbuild has already
      // recorded by the time it returns them.
      this.addWatchFile(filePath)

      const sourcePath = relative(projectRoot, filePath).split('\\').join('/')
      const compiled = isBundle
        ? bundleCompatSource({ sourcePath, entryPath: filePath, projectRoot })
        : compileCompatSource(await readFile(filePath, 'utf8'), { sourcePath })
      return `export default ${JSON.stringify(compiled)}`
    }
  }
}
