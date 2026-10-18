import CioCloudOff from '@codeio/icon/CioCloudOff.svelte'
import CioSearchX from '@codeio/icon/CioSearchX.svelte'
import CioShieldAlert from '@codeio/icon/CioShieldAlert.svelte'
import CioWifiOff from '@codeio/icon/CioWifiOff.svelte'
import type { Component } from 'svelte'
import type { GitRemoteIssueKind } from '$shared/types'

/**
 * One glyph and one heading per remote verdict, so the panel describes a remote
 * it cannot use the same way wherever the verdict is shown. The sentence itself
 * comes from main with the verdict, because the store also hands it back to
 * callers that report a failed remote action (a failed push, for one).
 */

/** The shape of the failure, readable at a glance before the sentence is read. */
export const REMOTE_ISSUE_ICONS: Readonly<Record<GitRemoteIssueKind, Component>> = {
  offline: CioWifiOff,
  denied: CioShieldAlert,
  missing: CioSearchX,
  unknown: CioCloudOff
}

/** The notice's heading: what happened, in as few words as the panel has room for. */
export const REMOTE_ISSUE_TITLES: Readonly<Record<GitRemoteIssueKind, string>> = {
  offline: 'Remote unreachable',
  denied: 'No access to the remote',
  missing: 'Remote repository not found',
  unknown: 'The remote could not be read'
}
