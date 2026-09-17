import type {
  RemoteAuditEventInfo,
  RemoteDeviceInfo,
  RemoteModeStatus,
  RemotePendingStepUpApproval
} from './remote'
import type { Contract } from './contract-helpers'

export const invokeRemoteContract = {
  'remote:getStatus': {} as Contract<[], RemoteModeStatus>,
  'remote:ensureGateway': {} as Contract<[], RemoteModeStatus>,
  'remote:toggle': {} as Contract<[enabled: boolean], RemoteModeStatus>,
  'remote:listDevices': {} as Contract<[], RemoteDeviceInfo[]>,
  'remote:disconnectDevice': {} as Contract<[deviceId: string], void>,
  'remote:renameDevice': {} as Contract<[deviceId: string, name: string], RemoteModeStatus>,
  'remote:revokeDevice': {} as Contract<[deviceId: string, reason: string], RemoteModeStatus>,
  'remote:approveStepUp': {} as Contract<[approvalId: string], boolean>,
  'remote:rejectStepUp': {} as Contract<[approvalId: string], boolean>,
  'remote:listPendingApprovals': {} as Contract<[], RemotePendingStepUpApproval[]>,
  'remote:listAuditEvents': {} as Contract<[limit: number], RemoteAuditEventInfo[]>,
  'remote:beginCloudEnrollment': {} as Contract<[], RemoteModeStatus>,
  'remote:resetCloudEnrollment': {} as Contract<[], RemoteModeStatus>
}
