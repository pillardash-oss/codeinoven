import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'path'

export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
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
