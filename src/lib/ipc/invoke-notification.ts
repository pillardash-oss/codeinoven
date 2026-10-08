import type {
  NotificationFamily,
  NotificationInboxSnapshot,
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
  'notification:openSettings': {} as Contract<[], boolean>,
  /**
   * Every notification the panel is still showing, oldest first. Read once per
   * window on boot so a restart returns the user to the inbox they left rather
   * than to an empty panel that thread-state hydration then partly refills.
   */
  'notification:listInbox': {} as Contract<[], NotificationInboxSnapshot>,
  /** Retire one entry the user dismissed by hand in the panel. */
  'notification:dismissInbox': {} as Contract<[id: string], void>,
  /** Drop every entry belonging to a thread that was deleted. */
  'notification:dismissInboxForThread': {} as Contract<[projectId: string, threadId: string], void>,
  /**
   * Clear one panel tab, or the whole inbox when no family is given. Tombstones
   * every id it retires, so thread-state hydration cannot rebuild an entry the
   * user just cleared.
   */
  'notification:clearInbox': {} as Contract<[family?: NotificationFamily], void>
}
