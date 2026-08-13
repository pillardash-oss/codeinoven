import { defineConfig, loadEnv } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import packageJson from './package.json'

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
        // Public endpoint baked into packaged desktops. Release CI maps the
        // GitHub Actions REMOTE_API_ORIGIN variable to this build-time value.
        __CODEINOVEN_REMOTE_API_ORIGIN__: JSON.stringify(
          env.MAIN_VITE_REMOTE_API_ORIGIN ?? 'https://mobile.codeinoven.com'
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
            '@anthropic-ai/claude-agent-sdk'
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
      define: {
        __CODEINOVEN_APP_VERSION__: JSON.stringify(packageJson.version)
      },
      root: resolve(__dirname, 'src/renderer'),
      publicDir: resolve(__dirname, 'src/renderer/static'),
      plugins: [svelte({ configFile: resolve(__dirname, 'svelte.config.js') }), tailwindcss()],
      resolve: {
        alias: {
          $lib: resolve(__dirname, 'src/renderer/lib'),
          $engines: resolve(__dirname, 'src/lib/engines'),
          $adapters: resolve(__dirname, 'src/lib/adapters'),
          $shared: resolve(__dirname, 'src/lib')
        }
      },
      build: {
        outDir: resolve(__dirname, 'out/renderer'),
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/renderer/index.html'),
            // Installable phone client (PWA): served by the LAN gateway in
            // production, or by the Vite dev server in development.
            remote: resolve(__dirname, 'src/renderer/remote.html')
          }
        }
      }
    }
  }
})
