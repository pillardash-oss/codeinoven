import type {
  GitHubNotificationFilter,
  GitHubNotificationPageInput,
  GitHubNotificationSubjectRequest,
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

/** `owner/repo`, the only repository spelling a GitHub request path accepts. */
const REPOSITORY_FULL_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u

/**
 * One request for the thread a notification points at.
 *
 * The repository is checked to the `owner/repo` shape because it is placed in the
 * request path, so a caller cannot walk out of the repository it names, and the
 * kind is bounded to the ones GitHub reports rather than forwarded as free text.
 */
export function validateNotificationSubjectRequest(
  value: unknown
): GitHubNotificationSubjectRequest {
  const record = assertRecord(value, 'Notification subject request')
  rejectUnknownFields(
    record,
    new Set(['repositoryFullName', 'subjectType', 'url']),
    'notification subject request'
  )
  const repositoryFullName = record['repositoryFullName']
  if (typeof repositoryFullName !== 'string' || !REPOSITORY_FULL_NAME.test(repositoryFullName)) {
    throw new TypeError('Repository must be an owner/repo full name')
  }
  const subjectType = record['subjectType']
  if (typeof subjectType !== 'string' || subjectType.length === 0 || subjectType.length > 40) {
    throw new TypeError('Subject type must be a non-empty string')
  }
  const url = record['url']
  if (url !== null && url !== undefined && typeof url !== 'string') {
    throw new TypeError('Subject URL must be a string or null')
  }
  return { repositoryFullName, subjectType, url: typeof url === 'string' ? url : null }
}
