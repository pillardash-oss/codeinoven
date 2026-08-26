import { defineConfig, loadEnv } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'path'
import type { Plugin, PluginOption, PreviewServer, ViteDevServer } from 'vite'
import packageJson from './package.json'

const pwaManifestPath = resolve(__dirname, 'src/renderer/static/manifest.webmanifest')
const pwaManifest = JSON.parse(readFileSync(pwaManifestPath, 'utf8')) as Record<string, unknown>
const versionedPwaManifest = `${JSON.stringify(
  { ...pwaManifest, version: packageJson.version },
  null,
  2
)}\n`

function serveVersionedPwaManifest(server: PreviewServer | ViteDevServer): void {
  server.middlewares.use((request, response, next) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (pathname !== '/manifest.webmanifest') {
      next()
      return
    }
    response.statusCode = 200
    response.setHeader('Content-Type', 'application/manifest+json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.end(versionedPwaManifest)
  })
}

/** Keep every served PWA manifest on the same version source as the desktop and remote UI. */
function pwaManifestVersionPlugin(): Plugin {
  return {
    name: 'codeinoven-pwa-manifest-version',
    configureServer: serveVersionedPwaManifest,
    configurePreviewServer: serveVersionedPwaManifest,
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: versionedPwaManifest
      })
    }
  }
}

/** Renderer root/aliases/plugins, shared with scripts/dev-remote-pwa.ts so a
 *  standalone Vite dev server for the phone PWA stays in sync with the real
 *  electron-vite renderer config instead of drifting out of a duplicate. */
export const rendererDefine = {
  __CODEINOVEN_APP_VERSION__: JSON.stringify(packageJson.version)
}
export const rendererRoot = resolve(__dirname, 'src/renderer')
export const rendererPublicDir = resolve(__dirname, 'src/renderer/static')
export const rendererAlias = {
  $lib: resolve(__dirname, 'src/renderer/lib'),
  $engines: resolve(__dirname, 'src/lib/engines'),
  $adapters: resolve(__dirname, 'src/lib/adapters'),
  $shared: resolve(__dirname, 'src/lib')
}
export function rendererPlugins(): PluginOption[] {
  return [
    pwaManifestVersionPlugin(),
    svelte({ configFile: resolve(__dirname, 'svelte.config.js') }),
    tailwindcss()
  ]
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
        // Bake the GitHub App client ID into the main bundle at build time.
        // The identifier is replaced by Vite's `define` from the shared
        // CODEINOVEN_GITHUB_CLIENT_ID value. Public by design — never a secret.
        __CODEINOVEN_GITHUB_CLIENT_ID__: JSON.stringify(env.CODEINOVEN_GITHUB_CLIENT_ID ?? ''),
        // Development keeps persisted Remote mode off unless the developer
        // explicitly opts into the LAN listeners for a phone test.
        __CODEINOVEN_DEV_REMOTE_MODE__: JSON.stringify(env.CODEINOVEN_DEV_REMOTE_MODE === '1'),
        // Public endpoint baked into packaged desktops. Release CI maps the
        // GitHub Actions REMOTE_API_ORIGIN variable to this build-time value.
        __CODEINOVEN_REMOTE_API_ORIGIN__: JSON.stringify(
          env.MAIN_VITE_REMOTE_API_ORIGIN ?? 'https://mobile.codeinoven.com'
        ),
        // Keep interactive account authentication on the stable mobile gateway.
        // Coolify resolves the current Convex account service at runtime.
        __CODEINOVEN_ACCOUNT_AUTH_ORIGIN__: JSON.stringify(
          env.MAIN_VITE_ACCOUNT_AUTH_ORIGIN ?? 'https://mobile.codeinoven.com'
        ),
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
          external: [
            'electron',
            'node-pty',
            'better-sqlite3',
            'electron-updater',
            '@anthropic-ai/claude-agent-sdk',
            'werift'
          ],
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
            index: resolve(__dirname, 'src/preload/index.ts'),
            'switcher-preload': resolve(__dirname, 'src/preload/switcher-preload.ts')
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
        alias: rendererAlias
      },
      build: {
        outDir: resolve(__dirname, 'out/renderer'),
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/renderer/index.html'),
            // Installable phone client (PWA): served by the LAN gateway in
            // production, or by the Vite dev server in development.
            remote: resolve(__dirname, 'src/renderer/remote.html'),
            // Standalone page loaded by the native Ctrl+Tab overlay view (it
            // must run in its own WebContentsView to stack above the browser).
            switcher: resolve(__dirname, 'src/renderer/switcher.html')
          }
        }
      }
    }
  }
})
