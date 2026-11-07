import adapter from '@sveltejs/adapter-static'
import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'

/**
 * SvelteKit 3 keeps its configuration here rather than in `svelte.config.js`.
 *
 * The mobile app is a static single page build: Capacitor copies `build/` into
 * the native shells, and rendering every route from local assets keeps the app
 * offline first. Only data is fetched.
 *
 * Development talks to the Go service through `/api`, so the browser build and
 * the native build share one path. A real device points `VITE_API_BASE` at the
 * machine running the backend instead, because a phone cannot reach the host's
 * loopback address.
 */
export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({ fallback: 'index.html', precompress: false, strict: false }),
      // SvelteKit 3 renamed `$lib` to `#lib`, but its sync step does not yet turn
      // the `imports` map below into TypeScript paths, so the editor would not
      // resolve `#lib` without this one entry. The alternative is a deprecated
      // warning, which is better than imports that only the bundler understands.
      //
      // `#shared` is the workstation's own platform-safe code (`src/lib` at the
      // repository root), which the desktop renderer reaches as `$shared`. The
      // phone reuses it rather than keeping a second copy of a rule both clients
      // obey: a composer that grows on its third line, an age in the app's
      // canonical ladder, a timestamp in the pinned locale.
      alias: { '#lib': 'src/lib', '#shared': '../../src/lib' }
    })
  ],
  server: {
    // The build reads the shared modules outside this package, so the dev server
    // has to serve them too. Everything above the mobile package is the app's own
    // source, never a dependency tree.
    fs: { allow: ['..', '../..'] },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  }
})
