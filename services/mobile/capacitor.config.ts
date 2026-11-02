import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The app loads its own static build, so the WebView never points at a dev
 * server in a shipped binary. A device that needs the backend at a LAN address
 * gets it through `VITE_API_BASE` at build time, not through this file.
 */
const config: CapacitorConfig = {
  appId: 'com.pillardash.codeinoven',
  appName: 'CodeInOven',
  webDir: 'build',
  ios: {
    contentInset: 'never',
    scrollEnabled: false
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#f7f6f2'
  }
}

export default config
