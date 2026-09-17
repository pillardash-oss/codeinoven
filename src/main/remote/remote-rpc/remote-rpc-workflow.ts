/**
 * Engineering workflow orchestration for the remote RPC bridge.
 *
 * The phone's brainstorm, PRD, assignment, audit, and achievement transitions
 * are routed to the same `ChatEngine` orchestration methods the desktop IPC
 * handlers call. These are agent orchestration channels, separate from the
 * plain agent chat surface in `remote-rpc-agent.ts`.
 */

import type {
  AuditGenerationRequest,
  BrainstormEntryChoice,
  BrainstormPrototypeFidelity,
  PromptAttachment,
  ThreadSettings
} from '../../../lib/types'
import type { RemoteRpcCallContext } from './remote-rpc-context'
import { REMOTE_RPC_UNHANDLED } from './remote-rpc-context'
import { requireString } from './remote-rpc-args'

export async function callRemoteWorkflowRpc(
  ctx: RemoteRpcCallContext,
  channel: string,
  args: unknown[]
): Promise<unknown | typeof REMOTE_RPC_UNHANDLED> {
  const { chatEngine } = ctx
  switch (channel) {
    case 'agent:chooseBrainstormEntry':
      return chatEngine.chooseBrainstormEntry(
        requireString(args[0]),
        requireString(args[1]),
        args[2] as BrainstormEntryChoice
      )
    case 'agent:reviewBrainstorm':
      return chatEngine.reviewBrainstorm(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        typeof args[4] === 'string' ? args[4] : '',
        args[5] === undefined
          ? undefined
          : {
              prototypeRequest: args[5] as {
                fidelity: BrainstormPrototypeFidelity
                count?: number
              }
            }
      )
    case 'agent:finalizeBrainstorm':
      return chatEngine.finalizeBrainstorm(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        typeof args[4] === 'string' ? args[4] : ''
      )
    case 'agent:generatePrd':
      return chatEngine.generatePrd(
        requireString(args[0]),
        requireString(args[1]),
        args[2] as ThreadSettings,
        requireString(args[3]),
        args[4] as PromptAttachment[],
        requireString(args[5])
      )
    case 'agent:ensureInitialSpec':
      return chatEngine.ensureInitialSpec(requireString(args[0]), requireString(args[1]))
    case 'prototypePreview:readChunk':
      return chatEngine.readPrototypePreviewChunk(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number
      )
    case 'agent:ensureImplementationAuditorThread':
      return chatEngine.ensureImplementationAuditorThread(
        requireString(args[0]),
        requireString(args[1]),
        args[2] as ThreadSettings
      )
    case 'agent:startAssignment':
      return chatEngine.startAssignment(
        requireString(args[0]),
        requireString(args[1]),
        (args[2] as 'user' | 'internal') ?? 'user'
      )
    case 'agent:stopAssignment':
      return chatEngine.stopAssignment(requireString(args[0]), requireString(args[1]))
    case 'agent:resumeAssignment':
      return chatEngine.resumeAssignment(requireString(args[0]), requireString(args[1]))
    case 'agent:generateAudit':
      return chatEngine.generateAudit(
        requireString(args[0]),
        requireString(args[1]),
        args[2] as AuditGenerationRequest
      )
    case 'agent:ensureAssignmentAuditorThread':
      return chatEngine.ensureAssignmentAuditorThread(
        requireString(args[0]),
        requireString(args[1]),
        args[2] as ThreadSettings
      )
    case 'agent:generateAssignmentAudit':
      return chatEngine.generateAssignmentAudit(
        requireString(args[0]),
        requireString(args[1]),
        args[2] as ThreadSettings
      )
    case 'agent:generateAssignmentDraft':
      return chatEngine.generateAssignmentDraft(
        requireString(args[0]),
        requireString(args[1]),
        args[2] as ThreadSettings
      )
    case 'agent:ensureAchievementScope':
      return chatEngine.ensureAchievementScope(requireString(args[0]), requireString(args[1]))
    case 'agent:ensureAchievementAuditorThread':
      return chatEngine.ensureAchievementAuditorThread(
        requireString(args[0]),
        requireString(args[1]),
        args[2] as ThreadSettings
      )
    case 'agent:generateAchievementAudit':
      return chatEngine.generateAchievementAudit(
        requireString(args[0]),
        requireString(args[1]),
        args[2] as ThreadSettings
      )
    case 'agent:submitAchievementAuditFeedback':
      return chatEngine.submitAchievementAuditFeedback(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        requireString(args[4])
      )
    case 'agent:returnAchievementAuditToOffer':
      return chatEngine.returnAchievementAuditToOffer(
        requireString(args[0]),
        requireString(args[1])
      )
    case 'agent:submitAssignmentAuditFeedback':
      return chatEngine.submitAssignmentAuditFeedback(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        requireString(args[4])
      )
    default:
      return REMOTE_RPC_UNHANDLED
  }
}
