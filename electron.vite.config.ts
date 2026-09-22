import { defineConfig, loadEnv } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'path'
import type { PluginOption } from 'vite'
import packageJson from './package.json'

// Nightly CI resolves the full prerelease semver (e.g. 0.5.53-nightly.4) before
// packaging and passes it here so the splash/about surfaces show the exact
// build instead of the bare package.json version electron-builder would
// otherwise fall back to.
const resolvedAppVersion = process.env['CODEINOVEN_BUILD_VERSION'] || packageJson.version

/** Renderer dev port of the primary checkout. */
const DEFAULT_RENDERER_PORT = 5173
/** Deterministic port pool reserved for linked Git worktrees. */
const WORKTREE_PORT_BASE = 5200
const WORKTREE_PORT_POOL = 800

/**
 * Is this config loaded from a linked Git worktree (`git worktree add`)?
 * A linked worktree stores a `.git` *file* holding its `gitdir:` pointer, while
 * a regular checkout has a `.git` *directory*.
 */
function isLinkedWorktree(root: string): boolean {
  try {
    return statSync(join(root, '.git')).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve the renderer dev-server port.
 *
 * The port is part of the renderer origin, and the renderer persists its
 * recovery snapshot, thread visits, and UI preferences in origin-keyed
 * localStorage   so the primary checkout keeps the stable 5173 it has always
 * had. A linked worktree instead gets a port of its own, derived from its own
 * path, so any number of worktrees can run `bun dev` side by side while each
 * one still keeps the exact same origin (and therefore the same persisted
 * state) across every restart. `CODEINOVEN_RENDERER_PORT` overrides the choice
 * outright; `strictPort` stays on so a taken port fails loudly instead of
 * silently moving the origin and losing that state.
 */
function resolveRendererPort(root: string): number {
  const override = process.env['CODEINOVEN_RENDERER_PORT']?.trim()
  if (override) {
    const parsed = Number(override)
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      throw new Error(
        `CODEINOVEN_RENDERER_PORT must be an integer between 1024 and 65535 (received "${override}")`
      )
    }
    return parsed
  }
  if (!isLinkedWorktree(root)) return DEFAULT_RENDERER_PORT
  let stableRoot = root
  try {
    stableRoot = realpathSync.native(root)
  } catch {
    // Fall back to the unresolved path; the port stays stable for this checkout.
  }
  const digest = createHash('sha256').update(stableRoot).digest()
  return WORKTREE_PORT_BASE + (digest.readUInt32BE(0) % WORKTREE_PORT_POOL)
}

/** Renderer root/aliases/plugins, shared by the builders so any additional
 *  renderer bundle stays in sync with the real electron-vite renderer config
 *  instead of drifting out of a duplicate. */
export const rendererDefine = {
  __CODEINOVEN_APP_VERSION__: JSON.stringify(resolvedAppVersion)
}
export const rendererRoot = resolve(__dirname, 'src/renderer')
export const rendererPublicDir = resolve(__dirname, 'src/renderer/static')
export const rendererAlias = {
  $lib: resolve(__dirname, 'src/renderer/lib'),
  $engines: resolve(__dirname, 'src/lib/engines'),
  $adapters: resolve(__dirname, 'src/lib/adapters'),
  $shared: resolve(__dirname, 'src/lib')
}
export const rendererDedupe = [
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
  '@codemirror/language-data',
  '@codemirror/commands',
  '@lezer/highlight',
  '@lezer/common',
  '@lezer/lr'
]
export function rendererPlugins(): PluginOption[] {
  return [svelte({ configFile: resolve(__dirname, 'svelte.config.js') }), tailwindcss()]
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), [
    'VITE_',
    'MAIN_VITE_',
    'PRELOAD_VITE_',
    'RENDERER_VITE_',
    'CODEINOVEN_'
  ])
  return {
    main: {
      define: {
        // Keep the splash copy tied to the package version used to build the
        // Electron bundle (or the CI-resolved nightly prerelease version).
        __CODEINOVEN_APP_VERSION__: JSON.stringify(resolvedAppVersion),
        // Bake the GitHub App client ID into the main bundle at build time.
        // The identifier is replaced by Vite's `define` from the shared
        // CODEINOVEN_GITHUB_CLIENT_ID value. Public by design — never a secret.
        __CODEINOVEN_GITHUB_CLIENT_ID__: JSON.stringify(env.CODEINOVEN_GITHUB_CLIENT_ID ?? ''),
        // Public, isolated origin for generated Engineering prototype previews.
        // There is deliberately no production default.
        __CODEINOVEN_PROTOTYPE_PREVIEW_ORIGIN__: JSON.stringify(
          env.MAIN_VITE_PUBLIC_PROTOTYPE_PREVIEW_ORIGIN ?? ''
        )
      },
      build: {
        outDir: 'out/main',
        rollupOptions: {
          // better-sqlite3 is a native module — it must remain external to preserve binding paths.
          // @anthropic-ai/claude-agent-sdk is bundled (not external) so it can
          // live in devDependencies: it's a pure-JS control-protocol client
          // with no native bindings, so inlining it avoids shipping the whole
          // package inside node_modules in the packaged app.
          external: ['electron', 'node-pty', 'better-sqlite3', 'electron-updater'],
          input: {
            index: resolve(__dirname, 'src/main/index.ts')
          }
        }
      }
    },
    preload: {
      build: {
        outDir: 'out/preload',
        rollupOptions: {
          external: ['electron'],
          input: {
            index: resolve(__dirname, 'src/preload/index.ts')
          },
          // Sandboxed Electron preloads execute in a CommonJS-like isolated
          // context. Emitting ESM here makes production fail before the bridge
          // can be exposed (`Cannot use import statement outside a module`).
          output: {
            format: 'cjs',
            entryFileNames: '[name].cjs'
          }
        }
      }
    },
    renderer: {
      define: rendererDefine,
      root: rendererRoot,
      publicDir: rendererPublicDir,
      plugins: rendererPlugins(),
      resolve: {
        alias: rendererAlias,
        // CodeMirror's instanceof-based extension checks break if any chunk
        // ends up with a private copy of @codemirror/state (e.g. a stale
        // optimizeDeps snapshot taken while nested 6.7.1 copies existed).
        // Deduping here forces every importer onto the single hoisted copy.
        dedupe: rendererDedupe
      },
      optimizeDeps: {
        // Bundle the CodeMirror core packages as shared pre-bundled deps so
        // the dynamic imports in codemirror-file-editor.ts and every language
        // package resolve to one instance instead of separate chunks.
        include: [
          '@codemirror/state',
          '@codemirror/view',
          '@codemirror/commands',
          '@codemirror/language',
          '@codemirror/language-data'
        ]
      },
      // Pin the dev origin. The renderer's persisted state (recovery snapshot,
      // thread visits, UI preferences) lives in localStorage keyed by origin,
      // so a port that drifts when 5173 is busy silently loses every restart
      // restore   the app would boot with empty persisted state. Each linked
      // worktree therefore owns a stable port of its own (see
      // `resolveRendererPort`) instead of fighting the primary checkout for
      // 5173.
      server: {
        port: resolveRendererPort(__dirname),
        strictPort: true
      },
      build: {
        outDir: resolve(__dirname, 'out/renderer'),
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/renderer/index.html')
          }
        }
      }
    }
  }
})
