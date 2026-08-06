import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  },
  resolve: {
    alias: {
      $lib: resolve(__dirname, 'src/renderer/lib'),
      $engines: resolve(__dirname, 'src/lib/engines'),
      $adapters: resolve(__dirname, 'src/lib/adapters'),
      $shared: resolve(__dirname, 'src/lib')
    }
  }
})
