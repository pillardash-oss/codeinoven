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
import { buildSync, transformSync } from 'esbuild'
import { readFileSync } from 'node:fs'

/** The Vite import query a shim is reached through. */
export const COMPAT_SOURCE_QUERY = 'compat-source'

/** The Vite import query a multi-module shim is reached through. */
export const COMPAT_BUNDLE_QUERY = 'compat-bundle'

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

/**
 * A trailing run of `//` and `/* *\/` comments, which esbuild drops and we keep.
 *
 * A bundled entry ends with prose the app reads back out of the injected copy   a
 * closing marker, in the preamble's case, which is how an already installed
 * extension is recognised and rewritten   so the rule for the leading block holds
 * at the other end of the file too.
 */
const TRAILING_DOCUMENTATION = /(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*\n?))+\s*$/u

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

/** The entry's closing comment run, which a bundle would otherwise drop. */
function trailingDocumentation(source: string): string {
  const match = TRAILING_DOCUMENTATION.exec(source)
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

export interface CompatBundleOptions {
  /** Project-root-relative path of the entry module, used in the banner and in errors. */
  sourcePath: string
  /** Absolute path of the entry module, the one the other shims import. */
  entryPath: string
  /** Absolute project root, the base esbuild resolves module specifiers against. */
  projectRoot: string
}

/** The directive esbuild stamps on a bundle because its entry is a module. */
const STRICT_DIRECTIVE = /^\s*["']use strict["'];?/u

/**
 * Bundle one shim that has outgrown a single file into the text that gets injected.
 *
 * `compileCompatSource` above transforms one file and cannot follow an import: its
 * output is refused if any module boundary survives. A shim large enough to need a
 * by-concern split holds real modules that import each other, so this path bundles
 * them instead and esbuild lands the whole graph in one IIFE with no import left
 * behind.
 *
 * The output is deliberately NOT minified and NOT tree-shaken. Both would change how
 * the injected copy reads when a developer opens it inside an installed extension,
 * and `treeShaking: false` is also what keeps a concern module that only patches a
 * namespace for side effect from disappearing.
 */
export function bundleCompatSource(options: CompatBundleOptions): string {
  const entrySource = readFileSync(options.entryPath, 'utf8')
  const result = buildSync({
    entryPoints: [options.entryPath],
    absWorkingDir: options.projectRoot,
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    treeShaking: false,
    minify: false,
    legalComments: 'none',
    // The Electron this app ships is far ahead of this floor; it is stated so the
    // output never carries a syntax transform nobody asked for.
    target: 'chrome120',
    logLevel: 'silent'
  })

  const output = result.outputFiles && result.outputFiles[0]
  if (!output) {
    throw new Error(`${options.sourcePath} bundled to nothing; an injected shim cannot be empty.`)
  }

  const body = output.text.trim()
  const moduleSyntax = COMPILE_TIME_MODULE_SYNTAX.exec(body)
  if (moduleSyntax) {
    throw new Error(
      `${options.sourcePath} bundled to ${describeModuleSyntaxKind(moduleSyntax[0])}, which cannot ` +
        'be injected: the target page resolves it against its own origin and fails to load.'
    )
  }

  // A bundle's entry is an ES module, so esbuild declares strict mode at the top of
  // the output. The copy this replaces was a classic script and was never strict: it
  // runs in an extension's own scripts, where a failed assignment is meant to be
  // ignored rather than thrown. The directive is removed unless the entry asked for
  // strict mode itself, so the injected copy keeps the mode it always ran in.
  const entryDeclaresStrictMode = /^[ \t]*["']use strict["']/mu.test(entrySource)
  const injected =
    STRICT_DIRECTIVE.test(body) && !entryDeclaresStrictMode
      ? body.replace(STRICT_DIRECTIVE, '').trimStart()
      : body

  const banner = `// Bundled from ${options.sourcePath} at build time. Edit that module, not this copy.`
  return (
    [banner, leadingDocumentation(entrySource), injected, trailingDocumentation(entrySource)]
      .filter((part) => part !== '')
      .join('\n\n') + '\n'
  )
}
