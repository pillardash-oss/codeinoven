import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'path'

// `import.meta.dirname` is what Vite's native config loader supports; `__dirname`
// is the one feature that warns under `configLoader: 'native'`.
const projectRoot = import.meta.dirname

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
    hookTimeout: 30_000,
    // Browser APIs jsdom does not implement (`matchMedia` above all) have to
    // exist before a test file's module graph is imported, so they are installed
    // for every test file here rather than repeated inside each jsdom suite.
    // A hermetic temp root set once before the workers spawn keeps the local
    // test run's temp layout identical to CI's (see tests/setup/hermetic-temp-root.ts).
    globalSetup: ['./tests/setup/hermetic-temp-root.ts'],
    setupFiles: ['./tests/setup/jsdom-dom-shims.ts']
  },
  resolve: {
    conditions: ['browser'],
    alias: {
      $lib: resolve(projectRoot, 'src/renderer/lib'),
      $engines: resolve(projectRoot, 'src/lib/engines'),
      $adapters: resolve(projectRoot, 'src/lib/adapters'),
      $shared: resolve(projectRoot, 'src/lib')
    }
  }
})
