import { defineConfig, loadEnv } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode)
  return {
    main: {
      define: {
        // Bake the GitHub App client ID into the main bundle at build time.
        // The identifier is replaced by Vite's `define` from the `.env` value
        // MAIN_VITE_GITHUB_CLIENT_ID. Public by design — never a secret.
        __CODEINOVEN_GITHUB_CLIENT_ID__: JSON.stringify(env.MAIN_VITE_GITHUB_CLIENT_ID ?? '')
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
          }
        }
      }
    },
    renderer: {
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
