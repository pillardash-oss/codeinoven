import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
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
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
