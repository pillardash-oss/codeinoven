import type {
  SystemNotificationPermissionStatus,
  SystemNotificationTestResult
} from './notifications'
import type { Contract } from './contract-helpers'

export const invokeNotificationContract = {
  'notification:test': {} as Contract<[], SystemNotificationTestResult>,
  'notification:getPermissionStatus': {} as Contract<[], SystemNotificationPermissionStatus>,
  /**
   * Open the OS notification-settings pane (System Settings on macOS, Settings
   * on Windows). The target URL is a hard-coded, platform-specific allow-list
   * constant resolved in the main process: never renderer-supplied: so it is
   * safe to bypass the web-only external-URL validator. Returns false when the
   * platform has no notification-settings deep link.
   */
  'notification:openSettings': {} as Contract<[], boolean>
}
