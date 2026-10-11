import type {
  GitHubNotificationFilter,
  GitHubNotificationPageInput,
  GitHubNotificationTab
} from '../../../lib/types'
import { assertEnum, assertRecord, rejectUnknownFields, validateBoundedInteger } from './primitives'

const NOTIFICATION_TABS: ReadonlySet<GitHubNotificationTab> = new Set(['inbox', 'saved', 'done'])

const NOTIFICATION_FILTERS: ReadonlySet<GitHubNotificationFilter> = new Set([
  'default',
  'all',
  'assigned',
  'participating',
  'mentioned',
  'team-mentioned',
  'review-requested',
  'security',
  'ci'
])

/** GitHub thread ids are decimal numbers; accept either spelling from the wire. */
export function validateNotificationThreadId(value: unknown): string {
  const raw =
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : null
  if (raw === null || !/^[0-9]{1,20}$/u.test(raw)) {
    throw new TypeError('Notification thread ID must be a decimal number')
  }
  return raw
}

/** One notification listing request, with the page bounded so a caller cannot over-fetch. */
export function validateNotificationPageInput(value: unknown): GitHubNotificationPageInput {
  const record = assertRecord(value, 'Notification page input')
  rejectUnknownFields(record, new Set(['tab', 'filter', 'page', 'perPage']), 'notification page')
  return {
    tab: assertEnum(record['tab'], NOTIFICATION_TABS, 'notification tab'),
    filter: assertEnum(record['filter'], NOTIFICATION_FILTERS, 'notification filter'),
    page: validateBoundedInteger(record['page'], 'Page', 1, 1000),
    perPage: validateBoundedInteger(record['perPage'], 'Items per page', 1, 50)
  }
}

/**
 * A GitHub personal access token the user pasted into the panel.
 *
 * Deliberately not shape-checked beyond "one token, no whitespace": classic
 * tokens predate the `ghp_` prefix, and an OAuth token from another client (the
 * GitHub CLI's, for one) works here too. The length bound keeps an accidental
 * paste of a file inside the IPC payload and out of the vault.
 */
export function validateNotificationToken(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Token must be a string')
  const token = value.trim()
  if (token.length < 20 || token.length > 512) {
    throw new TypeError('Token must be between 20 and 512 characters')
  }
  if (!/^[A-Za-z0-9_]+$/u.test(token)) {
    throw new TypeError('Token must be a single GitHub token, with no other text')
  }
  return token
}
