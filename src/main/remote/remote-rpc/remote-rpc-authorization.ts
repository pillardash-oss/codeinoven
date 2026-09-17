/**
 * Device-scope and step-up authorization for the remote RPC bridge.
 *
 * This is the security gate for every remote invocation: deny by default, the
 * channel must have a registry entry, the device must hold the required scope
 * within its granted projects, and high-risk channels require a single-use
 * local approval bound to the exact request. Revalidation runs per invoke so
 * revocation, expiry, idle expiry, and key/scope rotation take effect at once.
 */

import {
  authorizationForChannel,
  type RemoteRpcDenied,
  type RemoteRpcDeviceContext,
  type RemoteRpcStepUpRequired
} from '../../../lib/remote-rpc'
import { DeviceCredentialService, sha256Hex } from '../device-credential-service'
import type { RemoteInvoke } from './remote-rpc-types'

export type RemoteRpcAuthorizationOutcome =
  | { allowed: true; stepUpApprovalId?: string | null }
  | { allowed: false; denied: RemoteRpcDenied | RemoteRpcStepUpRequired }

/**
 * Enforce the device-scope + step-up contract for a remote invocation.
 * Deny-by-default: the channel must have a registry entry, the device must
 * hold the required scope, and high-risk channels require a single-use local
 * approval bound to this exact request.
 */
export async function authorizeRemoteRpc(
  credentials: DeviceCredentialService | null,
  invoke: RemoteInvoke
): Promise<RemoteRpcAuthorizationOutcome> {
  const device = invoke.device as RemoteRpcDeviceContext
  const resource = remoteResourceForChannel(invoke.channel, invoke.args)
  const auth = authorizationForChannel(invoke.channel)
  if (!auth) {
    credentials?.audit({
      decision: 'rpc_denied',
      reasonCode: 'denied_by_default',
      deviceId: device.deviceId,
      deviceName: device.name,
      fingerprintPrefix: device.fingerprint.slice(0, 8),
      transport: device.transport,
      sessionId: device.sessionId,
      requestId: device.requestId,
      channel: invoke.channel,
      resourceId: resource,
      authVersion: device.authVersion
    })
    return {
      allowed: false,
      denied: { code: 'authorization_denied', scope: null, reason: 'channel not authorized' }
    }
  }
  // Per-invoke revalidation: revocation, expiry, idle expiry, and key/scope
  // rotation take effect immediately   a bound session is never trusted
  // statelessly even after the handshake succeeded.
  if (credentials && !credentials.isDeviceActive(device.deviceId, device.authVersion)) {
    credentials.audit({
      decision: 'rpc_denied',
      reasonCode:
        device.authVersion !==
        (credentials.getDevice(device.deviceId)?.authVersion ?? device.authVersion)
          ? 'superseded_auth_version'
          : 'revoked',
      deviceId: device.deviceId,
      deviceName: device.name,
      fingerprintPrefix: device.fingerprint.slice(0, 8),
      transport: device.transport,
      sessionId: device.sessionId,
      requestId: device.requestId,
      channel: invoke.channel,
      resourceId: resource,
      requiredScope: auth.scope,
      authVersion: device.authVersion
    })
    return {
      allowed: false,
      denied: {
        code: 'authorization_denied',
        scope: auth.scope,
        reason: 'device no longer active'
      }
    }
  }
  // Argument-level project bounds (contract 5.1): a scope never implies
  // workstation-wide access. Devices with a restricted project grant cannot
  // reach projects outside that set.
  if (!device.allProjects) {
    const projectId = typeof invoke.args[0] === 'string' ? invoke.args[0] : null
    if (projectId && !device.projectIds.includes(projectId)) {
      credentials?.audit({
        decision: 'rpc_denied',
        reasonCode: 'denied_by_default',
        deviceId: device.deviceId,
        deviceName: device.name,
        fingerprintPrefix: device.fingerprint.slice(0, 8),
        transport: device.transport,
        sessionId: device.sessionId,
        requestId: device.requestId,
        channel: invoke.channel,
        resourceId: resource,
        requiredScope: auth.scope,
        authVersion: device.authVersion
      })
      return {
        allowed: false,
        denied: { code: 'authorization_denied', scope: auth.scope, reason: 'project not granted' }
      }
    }
  }
  if (!device.scopes.includes(auth.scope)) {
    credentials?.audit({
      decision: 'rpc_denied',
      reasonCode: 'no_scope',
      deviceId: device.deviceId,
      deviceName: device.name,
      fingerprintPrefix: device.fingerprint.slice(0, 8),
      transport: device.transport,
      sessionId: device.sessionId,
      requestId: device.requestId,
      channel: invoke.channel,
      resourceId: resource,
      requiredScope: auth.scope,
      authVersion: device.authVersion
    })
    return {
      allowed: false,
      denied: {
        code: 'authorization_denied',
        scope: auth.scope,
        reason: `device lacks scope ${auth.scope}`
      }
    }
  }

  const needsStepUp =
    auth.stepUp === 'always' || (auth.stepUp === 'conditional' && auth.requiresStepUp === true)
  if (!needsStepUp || !credentials) {
    return { allowed: true, stepUpApprovalId: null }
  }

  const argsDigest = await sha256Hex(JSON.stringify(invoke.args))
  const approvedId = credentials.hasApprovalFor({
    deviceId: device.deviceId,
    authVersion: device.authVersion,
    sessionId: device.sessionId,
    requestId: device.requestId,
    channel: invoke.channel,
    resource,
    argsDigest
  })
  if (approvedId !== null) {
    return { allowed: true, stepUpApprovalId: approvedId }
  }

  const created = credentials.createStepUpApproval({
    deviceId: device.deviceId,
    authVersion: device.authVersion,
    sessionId: device.sessionId,
    requestId: device.requestId,
    channel: invoke.channel,
    action: invoke.channel,
    resource,
    argsDigest
  })
  if (created.ok && created.approval) {
    return {
      allowed: false,
      denied: {
        code: 'step_up_required',
        approvalId: created.approval.approvalId,
        expiresAt: created.approval.expiresAt,
        action: created.approval.action,
        resource: created.approval.resource
      }
    }
  }
  credentials.audit({
    decision: 'rpc_denied',
    reasonCode: 'denied_by_default',
    deviceId: device.deviceId,
    deviceName: device.name,
    fingerprintPrefix: device.fingerprint.slice(0, 8),
    transport: device.transport,
    sessionId: device.sessionId,
    requestId: device.requestId,
    channel: invoke.channel,
    resourceId: resource,
    requiredScope: auth.scope,
    authVersion: device.authVersion
  })
  return {
    allowed: false,
    denied: {
      code: 'authorization_denied',
      scope: auth.scope,
      reason: 'step-up capacity exceeded'
    }
  }
}

/** Coarse affected-resource label for step-up binding and audit records. */
export function remoteResourceForChannel(channel: string, args: unknown[]): string | null {
  const projectId = typeof args[0] === 'string' ? args[0] : null
  const threadId = typeof args[1] === 'string' ? args[1] : null
  if (channel.startsWith('project') || channel === 'git:init') {
    return projectId
  }
  if (projectId && threadId) return `${projectId}/${threadId}`
  if (projectId) return projectId
  return null
}

/** Local desktop approval for a pending step-up request (trusted IPC only). */
export function approveRemoteStepUp(
  credentials: DeviceCredentialService | null,
  approvalId: string,
  decision: 'approved' | 'rejected'
): boolean {
  if (!credentials) return false
  const pending = credentials
    .listPendingApprovals()
    .find((approval) => approval.approvalId === approvalId)
  if (!pending) return false
  return credentials.resolveStepUpApproval({
    approvalId,
    deviceId: pending.deviceId,
    authVersion: pending.authVersion,
    sessionId: pending.sessionId,
    requestId: pending.requestId,
    channel: pending.channel,
    resource: pending.resource,
    argsDigest: pending.argsDigest,
    decision
  })
}

export function listRemotePendingApprovals(
  credentials: DeviceCredentialService | null
): ReturnType<DeviceCredentialService['listPendingApprovals']> {
  return credentials?.listPendingApprovals() ?? []
}

export function listRemoteAuditEvents(
  credentials: DeviceCredentialService | null,
  limit = 100
): ReturnType<DeviceCredentialService['listAudit']> {
  return credentials?.listAudit(limit) ?? []
}
