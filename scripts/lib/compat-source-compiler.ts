/**
 * Compiles one injected browser-extension shim to the plain JavaScript the app
 * injects at run time.
 *
 * WHY THIS EXISTS
 * The files in `src/main/browser/extensions/compat/` are not modules the app
 * bundles: each one is written as text into an extension's own page, content
 * world or service worker, and that copy is executed by Chromium, not by this
 * app's bundle. They used to be `.js` imported through Vite's `?raw`, which
 * returns a file's exact bytes. That made them invisible to TypeScript, to the
 * linter's type-aware rules and to the 2000-line ceiling, and it is how a 3622
 * line shim survived in this repository with nobody checking it.
 *
 * They are authored as `.ts` now and imported through the `?compat-source` query,
 * which runs this compiler: the types are stripped by esbuild, the file's own
 * documentation block is kept, and the result is exported as one string.
 *
 * WHY THE OUTPUT IS GUARDED
 * A `?raw` import could never leak a module boundary, because it copied bytes.
 * Stripping types can, if someone writes a value import or an `export` in a shim:
 * the injected text would then contain `import ... from './helper'`, which the
 * target page resolves against ITS OWN origin and fails to load, silently
 * breaking the shim. {@link compileCompatSource} therefore refuses to produce
 * output that still holds module syntax, and the shim has to stay self-contained.
 */
import { transformSync } from 'esbuild'

/** The Vite import query a shim is reached through. */
export const COMPAT_SOURCE_QUERY = 'compat-source'

export interface CompatSourceCompileOptions {
  /** Project-root-relative path of the source, used in the banner and in errors. */
  sourcePath: string
}

/**
 * Module syntax that must not survive compilation.
 *
 * `import(` is a dynamic import and legal in an injected script, so the import
 * arm only matches a declaration. Anything else beginning with `import` or
 * `export` at the start of a statement is a module boundary and is refused.
 */
const COMPILE_TIME_MODULE_SYNTAX = /^[ \t]*(?:export\b|import(?![ \t]*\())/mu

/** A leading run of `//` and `/* *\/` comments, which esbuild drops and we keep. */
const LEADING_DOCUMENTATION = /^(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*\n))+/u

/** A guard failure names the shape it found, so the fix is obvious. */
function describeModuleSyntaxKind(line: string): string {
  return line.trimStart().startsWith('export') ? 'an export declaration' : 'an import declaration'
}

/**
 * The shim's own documentation block.
 *
 * esbuild strips every comment that is not a `/*!` legal comment, and the blocks
 * these files open with are the only record of what they work around and how it
 * was measured. The copy inside an installed extension is what a developer opens
 * when a shim is suspected, so the block is put back in front of the compiled
 * body rather than lost.
 */
function leadingDocumentation(source: string): string {
  const match = LEADING_DOCUMENTATION.exec(source)
  return match ? match[0].trim() : ''
}

/**
 * Compile one shim to the text that gets injected.
 *
 * The body is passed through esbuild's TypeScript transform only: no bundling, no
 * minification, no wrapping IIFE, so the injected code stays the same code the
 * file holds, in the same order, minus the types. That matters because these
 * scripts run in a classic-script world and in a module worker body alike, and a
 * wrapper changes what a top-level `var` or a hoisted declaration resolves to.
 */
export function compileCompatSource(source: string, options: CompatSourceCompileOptions): string {
  const compiled = transformSync(source, {
    loader: 'ts',
    format: 'esm',
    // The Electron this app ships is far ahead of this floor; it is stated so the
    // output never carries a syntax transform nobody asked for.
    target: 'chrome120',
    minify: false,
    legalComments: 'none',
    sourcefile: options.sourcePath,
    logLevel: 'silent'
  })

  const body = compiled.code.trim()
  if (body === '') {
    throw new Error(`${options.sourcePath} compiled to nothing; an injected shim cannot be empty.`)
  }

  const moduleSyntax = COMPILE_TIME_MODULE_SYNTAX.exec(body)
  if (moduleSyntax) {
    throw new Error(
      `${options.sourcePath} compiled to ${describeModuleSyntaxKind(moduleSyntax[0])}, which cannot ` +
        'be injected: the target page resolves it against its own origin and fails to load. ' +
        'An injected shim has to stay self-contained, so declare the types it needs inside the ' +
        'file instead of importing them, and never export from one.'
    )
  }

  const banner = `// Compiled from ${options.sourcePath} at build time. Types are stripped; edit that file.`
  const documentation = leadingDocumentation(source)
  return [banner, documentation, body].filter((part) => part !== '').join('\n\n') + '\n'
}
