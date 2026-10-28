import { homedir } from 'node:os'
import { app } from 'electron'
import type { NativeHostLookupOptions } from '../browser-native-host-manifest'
import type { BrowserExtensionService } from '../browser-extension-service'

/** BrowserExtensionService permissions: one concern, moved verbatim from the composition root. */
export class BrowserExtensionServicePermissions {
  constructor(private readonly host: BrowserExtensionService) {}

  nativeHostLookupOptions(): NativeHostLookupOptions {
    if (this.host.nativeLookupOptionsCache) return this.host.nativeLookupOptionsCache
    let userData = this.host.configRoot
    try {
      userData = app.getPath('userData')
    } catch {
      // A path that cannot be read leaves the app's own directory as the config
      // root, which is still a directory the app owns.
    }
    this.host.nativeLookupOptionsCache = { platform: process.platform, home: homedir(), userData }
    return this.host.nativeLookupOptionsCache
  }
}
