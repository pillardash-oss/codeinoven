/**
 * Agent chat surface for the remote RPC bridge.
 *
 * Every `agent:*` and `capabilities:*` channel the phone can invoke, routed to
 * the same `ChatEngine` the desktop IPC handlers use. Only channels in
 * `REMOTE_ALLOWED_CHANNELS` reach here; the dispatcher already authorized the
 * device before calling.
 */

import type {
  AgentCapabilitySource,
  AgentModelSelection,
  AgentSecretSubmission,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  PromptReference,
  SpecActionIntent,
  ThreadSettings,
  UserMessagePresentation
} from '../../../lib/types'
import type { RemoteRpcCallContext } from './remote-rpc-context'
import { REMOTE_RPC_UNHANDLED } from './remote-rpc-context'
import { optionalAccountUsageOverrides, optionalString, requireString } from './remote-rpc-args'

export async function callRemoteAgentRpc(
  ctx: RemoteRpcCallContext,
  channel: string,
  args: unknown[]
): Promise<unknown | typeof REMOTE_RPC_UNHANDLED> {
  const { chatEngine } = ctx
  switch (channel) {
    case 'agent:loadMessages':
      return chatEngine.loadMessages(requireString(args[0]), requireString(args[1]))
    case 'agent:listProviderSnapshot':
      return chatEngine.listProviderSnapshot(requireString(args[0]))
    case 'agent:refreshProviderCatalog':
      return chatEngine.listProviders(requireString(args[0]), args[1] !== false)
    case 'agent:refreshAccountUsage':
      return chatEngine.refreshAccountUsage(optionalAccountUsageOverrides(args[0]))
    case 'agent:getHarnessAuthStatus':
      return chatEngine.getHarnessAuthStatus(
        requireString(args[0]),
        requireString(args[1]),
        optionalString(args[2])
      )
    case 'agent:getSessionStatus':
      return chatEngine.getSessionStatus(requireString(args[0]), requireString(args[1]))
    case 'agent:ensureSession':
      return chatEngine.ensureSession(
        requireString(args[0]),
        requireString(args[1]),
        optionalString(args[2])
      )
    case 'agent:sendPrompt':
      return chatEngine.sendPrompt(
        requireString(args[0]),
        requireString(args[1]),
        args[2] as ThreadSettings,
        requireString(args[3]),
        (args[4] ?? []) as PromptAttachment[],
        args[5] as SpecActionIntent | undefined,
        optionalString(args[6]),
        optionalString(args[7]),
        args[8] as PromptReference[] | undefined,
        args[9] as PromptProjectReference[] | undefined,
        'user',
        args[10] as UserMessagePresentation | undefined,
        args[11] as PromptAssignmentTaskReference[] | undefined
      )
    case 'agent:steerPrompt':
      return chatEngine.steerPrompt(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        (args[3] ?? []) as PromptAttachment[],
        requireString(args[4]),
        optionalString(args[5]),
        args[6] as PromptReference[] | undefined,
        args[7] as PromptProjectReference[] | undefined,
        args[8] as UserMessagePresentation | undefined,
        args[9] as PromptAssignmentTaskReference[] | undefined
      )
    case 'agent:discardSteer':
      return chatEngine.discardSteer(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'agent:abort':
      return chatEngine.abort(requireString(args[0]), requireString(args[1]))
    case 'agent:listPermissions':
      return chatEngine.listPermissions(requireString(args[0]), requireString(args[1]))
    case 'agent:replyPermission':
      return chatEngine.replyPermission(
        requireString(args[0]),
        requireString(args[1]),
        args[2] as 'once' | 'always' | 'reject',
        typeof args[3] === 'string' ? args[3] : undefined
      )
    case 'agent:listImageDescriptorErrors':
      return chatEngine.listImageDescriptorErrors(requireString(args[0]), requireString(args[1]))
    case 'agent:replyImageDescriptor':
      return chatEngine.replyImageDescriptor(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as 'retry' | 'ignore' | 'false_positive',
        args[4] as AgentModelSelection | undefined
      )
    case 'agent:listQuestions':
      return chatEngine.listQuestions(requireString(args[0]), requireString(args[1]))
    case 'agent:answerQuestion':
      return chatEngine.answerQuestion(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as string[][]
      )
    case 'agent:answerSecret':
      return chatEngine.answerSecret(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as AgentSecretSubmission[]
      )
    case 'agent:dismissQuestion':
      return chatEngine.dismissQuestion(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'agent:updateQuestion':
      return chatEngine.updateQuestion(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        args[4] as string[],
        typeof args[5] === 'number' ? args[5] : undefined
      )
    case 'agent:listCommands':
      return chatEngine.listCommands(
        requireString(args[0]),
        requireString(args[1]),
        optionalString(args[2])
      )
    case 'agent:runCommand':
      return chatEngine.runCommand(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        requireString(args[3])
      )
    case 'agent:compact':
      return chatEngine.compactSession(requireString(args[0]), requireString(args[1]))
    case 'agent:truncateMessages':
      return chatEngine.truncateMessages(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'agent:deleteMessages':
      return chatEngine.deleteMessages(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        requireString(args[3]) as 'down' | 'single' | 'up'
      )
    case 'agent:listContextCapabilities':
      return chatEngine.listContextCapabilities(
        requireString(args[0]),
        requireString(args[1]),
        optionalString(args[2])
      )
    case 'agent:listProcesses':
      return chatEngine.listProcesses(requireString(args[0]), requireString(args[1]))
    case 'agent:listArtifacts':
      return chatEngine.listArtifacts(requireString(args[0]), requireString(args[1]))
    case 'agent:killProcess':
      return chatEngine.killProcess(
        requireString(args[0]),
        requireString(args[1]),
        args[2] as number
      )
    case 'agent:killThreadProcesses':
      return chatEngine.killThreadProcesses(requireString(args[0]), requireString(args[1]))
    case 'capabilities:deleteSkill':
      return chatEngine.deleteSkill(args[0] as AgentCapabilitySource)
    case 'capabilities:deleteMcp':
      return chatEngine.deleteMcp(args[0] as AgentCapabilitySource)
    case 'agent:sendTemporaryPrompt':
      return chatEngine.sendTemporaryPrompt(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as ThreadSettings,
        requireString(args[4]),
        (args[5] ?? []) as PromptAttachment[],
        (args[6] ?? []) as PromptReference[],
        optionalString(args[7]),
        optionalString(args[8]),
        optionalString(args[9])
      )
    case 'agent:steerTemporaryPrompt':
      return chatEngine.steerTemporaryPrompt(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as ThreadSettings,
        requireString(args[4]),
        (args[5] ?? []) as PromptAttachment[],
        (args[6] ?? []) as PromptReference[],
        optionalString(args[7]),
        optionalString(args[8])
      )
    case 'agent:loadTemporaryChatMessages':
      return chatEngine.loadTemporaryConversation(requireString(args[0]))
    case 'agent:getTemporaryChatStatus':
      return chatEngine.getTemporaryChatStatus(requireString(args[0]))
    case 'agent:abortTemporaryChat':
      return chatEngine.abortTemporaryChat(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'agent:touchTemporaryChat':
      return chatEngine.touchTemporaryChat(requireString(args[0]))
    case 'agent:closeTemporaryChat':
      return chatEngine.closeTemporaryChat(requireString(args[0]))
    case 'agent:loadSessionMessages':
      return chatEngine.loadSessionMessages(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'agent:getChildSessionStatus':
      return chatEngine.getChildSessionStatus(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'agent:dismissSessionError':
      return chatEngine.dismissSessionError(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'agent:retryChildSession':
      return chatEngine.retryChildSession(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'agent:abortChildSession':
      return chatEngine.abortChildSession(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2])
      )
    default:
      return REMOTE_RPC_UNHANDLED
  }
}
