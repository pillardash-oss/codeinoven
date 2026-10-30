import { CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES } from '../../../../lib/types'
import { isDevelopmentEnvironment, validateBaseUrl } from '../../../providers/base-url'
import { validateEntityId } from '../../ipc-validation'
import { isRecord, requireString } from '../shared'
import { requireTimestamp } from '../spec-helpers'
import type {
  CloudDeploymentConfig,
  CloudDeploymentContainer,
  CloudDeploymentProjectProviderAccounts,
  CloudDeploymentProviderKind,
  CloudDeploymentStatus
} from '../../../../lib/types'

const CLOUD_DEPLOYMENT_PROVIDER_KINDS = new Set<string>(CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES)

/**
 * How many project configs the container-ownership scan reads at once. Bounded
 * so a workspace with many projects does not open one file handle per project
 * in a single tick on the main thread.
 */
export const OWNERSHIP_SCAN_BATCH = 8
const CLOUD_DEPLOYMENT_STATUSES = new Set<string>(['building', 'success', 'failed', 'unknown'])
const CLOUD_DEPLOYMENT_MAX_TOKEN_LENGTH = 16_384

export function validateCloudDeploymentProviderKind(
  value: unknown,
  label = 'Provider kind'
): CloudDeploymentProviderKind {
  if (typeof value !== 'string' || !CLOUD_DEPLOYMENT_PROVIDER_KINDS.has(value)) {
    throw new TypeError(
      `${label} must be one of: ${CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES.join(', ')}`
    )
  }
  return value as CloudDeploymentProviderKind
}

function validateCloudDeploymentStatus(value: unknown, label: string): CloudDeploymentStatus {
  if (typeof value !== 'string' || !CLOUD_DEPLOYMENT_STATUSES.has(value)) {
    throw new TypeError(`${label} status must be building, success, failed, or unknown`)
  }
  return value as CloudDeploymentStatus
}

function validateCloudDeploymentContainer(value: unknown, index: number): CloudDeploymentContainer {
  if (!isRecord(value)) throw new TypeError(`Cloud deployment container ${index} must be an object`)
  return {
    id: requireString(value.id, `Cloud deployment container ${index} ID`, true),
    label: requireString(value.label, `Cloud deployment container ${index} label`),
    providerKind: validateCloudDeploymentProviderKind(
      value.providerKind,
      `Cloud deployment container ${index} provider kind`
    ),
    status: validateCloudDeploymentStatus(value.status, `Cloud deployment container ${index}`),
    ...(value.runtimeStatus === undefined
      ? {}
      : {
          runtimeStatus: validateCloudDeploymentStatus(
            value.runtimeStatus,
            `Cloud deployment container ${index} runtime`
          )
        }),
    ...(typeof value.accountId === 'string'
      ? {
          accountId: requireString(
            value.accountId,
            `Cloud deployment container ${index} account ID`,
            true
          )
        }
      : {}),
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
    ...(value.createdAt === undefined
      ? {}
      : {
          createdAt: requireTimestamp(
            value.createdAt,
            `Cloud deployment container ${index} creation`
          )
        }),
    ...(value.updatedAt === undefined
      ? {}
      : {
          updatedAt: requireTimestamp(value.updatedAt, `Cloud deployment container ${index} update`)
        }),
    ...(typeof value.log === 'string' ? { log: value.log } : {})
  }
}

/**
 * Validate a project's per-provider account association. The active account id,
 * when set, must reference one of the attached account ids.
 */
function validateCloudDeploymentProjectProviderAccounts(
  value: unknown,
  kind: CloudDeploymentProviderKind
): CloudDeploymentProjectProviderAccounts {
  if (!isRecord(value)) {
    throw new TypeError(`Cloud deployment account association for ${kind} must be an object`)
  }
  if (!Array.isArray(value.attachedAccountIds)) {
    throw new TypeError(`Cloud deployment account association for ${kind} must have attached ids`)
  }
  const attachedAccountIds = value.attachedAccountIds.map((id, index) =>
    requireString(id, `${kind} attached account ID ${index}`, true)
  )
  const activeAccountId =
    value.activeAccountId === null
      ? null
      : requireString(value.activeAccountId, `${kind} active account ID`, true)
  if (activeAccountId !== null && !attachedAccountIds.includes(activeAccountId)) {
    throw new TypeError(`Active account ${activeAccountId} is not attached for ${kind}`)
  }
  return { attachedAccountIds, activeAccountId }
}

/**
 * Validate a renderer-supplied cloud deployment config at the IPC boundary.
 * `projectId` is pinned to the channel argument so the renderer cannot persist
 * a config for a different project by passing a mismatched body. Accounts
 * themselves live in the global registry; this only validates the project's
 * provider/container selection and account association.
 */
export function validateCloudDeploymentConfig(
  value: unknown,
  projectId: string
): CloudDeploymentConfig {
  if (!isRecord(value)) throw new TypeError('Cloud deployment config must be an object')
  if (value.version !== 3) throw new TypeError('Unsupported cloud deployment config schema')
  if (validateEntityId(value.projectId, 'Config project ID') !== projectId) {
    throw new TypeError('Config project ID does not match the requested project')
  }
  if (!isRecord(value.project)) {
    throw new TypeError('Cloud deployment project config must be an object')
  }
  if (!Array.isArray(value.project.providers)) {
    throw new TypeError('Cloud deployment providers must be an array')
  }
  if (!Array.isArray(value.project.containers)) {
    throw new TypeError('Cloud deployment containers must be an array')
  }

  const providers: CloudDeploymentProviderKind[] = value.project.providers.map((provider, index) =>
    validateCloudDeploymentProviderKind(provider, `Provider ${index}`)
  )
  const seen = new Set<CloudDeploymentProviderKind>()
  for (const provider of providers) {
    if (seen.has(provider)) throw new TypeError(`Duplicate cloud deployment provider: ${provider}`)
    seen.add(provider)
  }

  const containers = value.project.containers.map((container, index) =>
    validateCloudDeploymentContainer(container, index)
  )
  const containerKeys = new Set<string>()
  for (const container of containers) {
    if (!providers.includes(container.providerKind)) {
      throw new TypeError(
        `Container ${container.id} references provider ${container.providerKind} that is not selected`
      )
    }
    const key = `${container.providerKind}/${container.id}`
    if (containerKeys.has(key)) {
      throw new TypeError(`Duplicate cloud deployment container mapping: ${key}`)
    }
    containerKeys.add(key)
  }

  let providerAccounts: CloudDeploymentConfig['project']['providerAccounts']
  if (value.project.providerAccounts === undefined) {
    providerAccounts = undefined
  } else if (!isRecord(value.project.providerAccounts)) {
    throw new TypeError('Cloud deployment account association must be an object')
  } else {
    providerAccounts = {}
    for (const key of Object.keys(value.project.providerAccounts)) {
      const kind = validateCloudDeploymentProviderKind(key)
      providerAccounts[kind] = validateCloudDeploymentProjectProviderAccounts(
        value.project.providerAccounts[key],
        kind
      )
    }
  }

  return {
    version: 3,
    projectId,
    project: {
      providers,
      containers,
      ...(providerAccounts === undefined ? {} : { providerAccounts })
    },
    updatedAt: requireTimestamp(value.updatedAt, 'Cloud deployment config update')
  }
}

export function validateProviderToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > CLOUD_DEPLOYMENT_MAX_TOKEN_LENGTH ||
    value.includes('\0')
  ) {
    throw new TypeError(
      `Provider token must be a string of at most ${CLOUD_DEPLOYMENT_MAX_TOKEN_LENGTH} characters`
    )
  }
  return value
}

export function validateAccountLabel(value: unknown): string {
  return requireString(value, 'Account label')
}

export function validateProviderBaseUrl(value: unknown, kind: CloudDeploymentProviderKind): string {
  if (typeof value !== 'string') throw new TypeError(`${kind} base URL must be a string`)
  const result = validateBaseUrl(value, { development: isDevelopmentEnvironment() })
  if (!result.ok || result.baseUrl === null) {
    throw new TypeError(`Invalid ${kind} base URL: ${result.reason ?? 'unsupported value'}`)
  }
  return result.baseUrl
}

/**
 * Fold a provider's live container results into the project's configured
 * container mappings for one provider kind. Only containers the user has mapped
 * are returned; each keeps the configured id and the user's custom label
 * (overriding whatever the provider reports). A mapped container the provider
 * has not returned yet is still represented with an unknown/available status so
 * configured containers always appear in the panel.
 */
export function mergeCloudDeploymentContainers(
  providerContainers: CloudDeploymentContainer[],
  mappedContainers: CloudDeploymentContainer[],
  kind: CloudDeploymentProviderKind
): CloudDeploymentContainer[] {
  const byId = new Map<string, CloudDeploymentContainer>()
  for (const container of providerContainers) byId.set(container.id, container)

  const merged: CloudDeploymentContainer[] = []
  for (const mapping of mappedContainers) {
    if (mapping.providerKind !== kind) continue
    const live = byId.get(mapping.id)
    if (!live) {
      merged.push({ ...mapping, status: 'unknown', runtimeStatus: 'unknown' })
      continue
    }
    merged.push({
      id: mapping.id,
      label: mapping.label,
      providerKind: kind,
      // The mapping's account binding is authoritative: a container monitored
      // through a specific account stays bound to it even when another account
      // also reports the same container id.
      ...(mapping.accountId === undefined ? {} : { accountId: mapping.accountId }),
      status: live.status,
      ...(live.runtimeStatus === undefined ? {} : { runtimeStatus: live.runtimeStatus }),
      ...(live.url === undefined ? {} : { url: live.url }),
      ...(live.project === undefined ? {} : { project: live.project }),
      ...(live.createdAt === undefined
        ? mapping.createdAt === undefined
          ? {}
          : { createdAt: mapping.createdAt }
        : { createdAt: live.createdAt }),
      ...(live.updatedAt === undefined
        ? mapping.updatedAt === undefined
          ? {}
          : { updatedAt: mapping.updatedAt }
        : { updatedAt: live.updatedAt }),
      ...(live.log === undefined ? {} : { log: live.log })
    })
  }
  return merged
}
