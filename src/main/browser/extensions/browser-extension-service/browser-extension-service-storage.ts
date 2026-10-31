import { browserPartitionFor } from '../../browser-service/browser-validation'
import {
  DARK_READER_EXTENSION_ID,
  type DarkReaderTabState
} from '../../../../lib/browser/browser-darkreader-control'
import type { BrowserExtensionService } from '../browser-extension-service'

/** BrowserExtensionService storage: one concern, moved verbatim from the composition root. */
export class BrowserExtensionServiceStorage {
  constructor(private readonly host: BrowserExtensionService) {}

  darkReaderTabState(projectId: string, boxId: string | null, tabId: number): DarkReaderTabState {
    const policy = this.host.darkReaderPolicies.get(browserPartitionFor(projectId, boxId))
    const record = this.host.registry.get(DARK_READER_EXTENSION_ID)
    return {
      supported: Boolean(record),
      enabled:
        Boolean(record?.enabled) &&
        (!policy ||
          ((policy.onlyTabId === null || policy.onlyTabId === tabId) &&
            !policy.disabledTabIds.includes(tabId))),
      scoped: policy !== undefined
    }
  }
}
