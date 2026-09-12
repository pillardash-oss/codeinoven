import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'path'

export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Slow CI runners (Windows in particular: git process spawns under Defender
    // scanning, cold JIT, pure-JS RSA key generation) can legitimately exceed
    // the 5s defaults, which timed out two tests in Quality #643. A generous
    // global headroom keeps CI green; genuinely hung tests still fail, just
    // more slowly.
    testTimeout: 30_000,
    hookTimeout: 30_000
  },
  resolve: {
    conditions: ['browser'],
    alias: {
      $lib: resolve(__dirname, 'src/renderer/lib'),
      $engines: resolve(__dirname, 'src/lib/engines'),
      $adapters: resolve(__dirname, 'src/lib/adapters'),
      $shared: resolve(__dirname, 'src/lib')
    }
  }
})
