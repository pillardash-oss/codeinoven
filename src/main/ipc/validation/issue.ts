import {
  MAX_GITHUB_NUMERIC_ID,
  assertEnum,
  assertRecord,
  rejectUnknownFields,
  validateBoundedInteger,
  validateBoundedString
} from './primitives'
import { validatePrAssigneeLogins, validatePrLabelNames } from './pr'

/**
 * Which of the viewer's relationships an issue listing can narrow to. These are
 * exactly GitHub's search qualifiers, one per member, and `all` is the absence of
 * one. Kept apart from the pull request filters because an issue has no reviewer
 * to be requested from.
 */
const ISSUE_LIST_FILTERS = new Set<import('../../../lib/types').IssueListFilter>([
  'all',
  'created',
  'assigned',
  'mentioned',
  'involves'
])
/**
 * The orderings an issue listing accepts. The same set the pull request listing
 * offers, because GitHub's search index orders both kinds of node the same way.
 */
const ISSUE_LIST_SORTS = new Set<import('../../../lib/types').IssueListSort>([
  'updated',
  'created',
  'comments-desc',
  'updated-asc',
  'created-asc',
  'comments-asc'
])
const ISSUE_STATES = new Set<'open' | 'closed'>(['open', 'closed'])
/**
 * The closure reasons a caller may record. `reopened` is deliberately absent: it
 * is a state GitHub reports, never one a writer sends.
 */
const ISSUE_STATE_REASONS = new Set<'completed' | 'not_planned'>(['completed', 'not_planned'])

/** Validate an issue number, which GitHub issues as a positive integer. */
export function validateIssueNumber(value: unknown): number {
  return validateBoundedInteger(value, 'Issue number', 1, MAX_GITHUB_NUMERIC_ID)
}

/** Validate the state an issue is being moved to (open|closed). */
export function validateIssueState(value: unknown): 'open' | 'closed' {
  return assertEnum(value, ISSUE_STATES, 'issue state')
}

/** Validate why an issue is being closed (completed|not_planned). */
export function validateIssueStateReason(value: unknown): 'completed' | 'not_planned' {
  return assertEnum(value, ISSUE_STATE_REASONS, 'issue state reason')
}

/** Validate an issue title, which GitHub caps the same way it caps a PR title. */
export function validateIssueTitle(value: unknown): string {
  return validateBoundedString(value, 'Issue title', 1, 512)
}

/**
 * Validate an issue listing request: which relationship to keep, how to order,
 * and where to continue from.
 *
 * The three travel together as one value because a cursor only means anything
 * alongside the filter and sort that produced it. `cursor` may be absent or null
 * (the first page); anything else is bounded, since a GitHub cursor is an opaque
 * base64 blob the provider only ever echoes back.
 */
export function validateIssueListRequest(
  value: unknown
): import('../../../lib/types').IssueListRequest {
  const input = assertRecord(value, 'Issue list request')
  rejectUnknownFields(input, new Set(['filter', 'sort', 'cursor']), 'issue list request')
  return {
    filter: assertEnum(input.filter, ISSUE_LIST_FILTERS, 'issue list filter'),
    sort: assertEnum(input.sort, ISSUE_LIST_SORTS, 'issue list sort'),
    cursor:
      input.cursor === undefined || input.cursor === null
        ? null
        : validateBoundedString(input.cursor, 'Issue list cursor', 1, 512)
  }
}

/**
 * Validate a new issue as the renderer asks for one.
 *
 * Labels and assignees are the same sets a pull request accepts, on purpose: a
 * label list and an assignee list are repository facts, and both are written
 * through the same issue fields on GitHub, so the same bounds apply.
 */
export function validateNewIssueInput(value: unknown): import('../../../lib/types').NewIssueInput {
  const input = assertRecord(value, 'New issue')
  rejectUnknownFields(input, new Set(['title', 'body', 'labels', 'assignees']), 'new issue')
  const issue: import('../../../lib/types').NewIssueInput = {
    title: validateIssueTitle(input.title)
  }
  if (input.body !== undefined) {
    if (typeof input.body !== 'string' || input.body.length > 65_536 || input.body.includes('\0')) {
      throw new TypeError('Issue body must be a string of at most 65536 characters')
    }
    issue.body = input.body
  }
  if (input.labels !== undefined) issue.labels = validatePrLabelNames(input.labels)
  if (input.assignees !== undefined) issue.assignees = validatePrAssigneeLogins(input.assignees)
  return issue
}
