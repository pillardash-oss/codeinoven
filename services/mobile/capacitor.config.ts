import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The app loads its own static build, so the WebView never points at a dev
 * server in a shipped binary. A device that needs the backend at a LAN address
 * gets it through `VITE_API_BASE` at build time, not through this file.
 */

/**
 * Mixed content is allowed only when the build itself targets a plain HTTP API,
 * which is the emulator and LAN development case and never a shipped build. A
 * production build keeps the WebView closed to insecure requests, so this cannot
 * become a property of the app the stores receive.
 */
const devApi = (process.env.VITE_API_BASE ?? '').startsWith('http://')
const config: CapacitorConfig = {
  appId: 'com.pillardash.codeinoven',
  appName: 'CodeInOven',
  webDir: 'build',
  ios: {
    contentInset: 'never',
    scrollEnabled: false
  },
  android: {
    /**
     * The shell is served from `https://localhost`, so a build pointed at a plain
     * HTTP development backend is mixed content and the WebView drops the request
     * before it leaves the app. The cleartext host allowlist in
     * `android/app/src/main/res/xml/network_security_config.xml` still narrows the
     * exception to the emulator host alias.
     */
    allowMixedContent: devApi,
    backgroundColor: '#f7f6f2'
  }
}

export default config
