import type {
  Oven,
  OvenState,
  OvenProbe,
  SaveOvenInput,
  OvenRun,
  OvenWorkspaceRequest,
  OvenWorkspaceResult,
  OvenTransferInput,
  OvenTransferReview,
  OvenSetupPreflightResult,
  OvenSetupProgressEvent,
  OvenSetupOperation,
  OvenHarnessInventoryItem,
  OvenTimezoneSyncResult,
  StartOvenSetupInput,
  OvenAgentScript,
  OvenAgentScriptRequest,
  OvenAgentPreview,
  OvenAgentRegistrationInput,
  OvenAgentRegistration
} from '../ovens'
import type { OvenConnectionStatus } from '../ovens'
import type { Contract } from './contract-helpers'
import type { Thread } from '../types'

export const invokeOvenContract = {
  'oven:testConnection': {} as Contract<[input: SaveOvenInput], OvenConnectionStatus>,
  'oven:connectionHealth': {} as Contract<[id: string], OvenConnectionStatus>,
  'oven:validateIdentity': {} as Contract<[path: string], string>,
  'oven:rootOperation': {} as Contract<
    [
      projectId: string,
      threadId: string,
      channel: string,
      args: unknown[],
      expectedOvenId?: string
    ],
    unknown
  >,
  'oven:state': {} as Contract<[], OvenState>,
  'oven:save': {} as Contract<[input: SaveOvenInput], Oven>,
  'oven:remove': {} as Contract<[id: string], OvenState>,
  'oven:setDefault': {} as Contract<[id: string], OvenState>,
  'oven:reorder': {} as Contract<[ids: string[]], OvenState>,
  'oven:install': {} as Contract<[id: string], OvenProbe>,
  'oven:probe': {} as Contract<[id: string], OvenProbe>,
  'oven:runs': {} as Contract<[id: string], OvenRun[]>,
  'oven:workspace': {} as Contract<[id: string, input: OvenWorkspaceRequest], OvenWorkspaceResult>,
  'oven:reviewTransfer': {} as Contract<[input: OvenTransferInput], OvenTransferReview>,
  'oven:transfer': {} as Contract<[reviewId: string], OvenTransferReview>,
  'oven:previewPort': {} as Contract<[id: string, port: number], string>,
  'oven:preview': {} as Contract<[id: string, root: string], string>,
  'oven:selectThread': {} as Contract<
    [projectId: string, threadId: string, id: string, root?: string],
    Thread
  >,
  'oven:setup:preflight': {} as Contract<[id: string], OvenSetupPreflightResult>,
  'oven:setup:start': {} as Contract<[id: string, input: StartOvenSetupInput], OvenSetupOperation>,
  'oven:setup:status': {} as Contract<[id: string], OvenSetupOperation | null>,
  'oven:setup:progress': {} as Contract<
    [id: string, after?: number],
    { events: OvenSetupProgressEvent[]; hasMore: boolean }
  >,
  'oven:setup:cancel': {} as Contract<[id: string], OvenSetupOperation>,
  'oven:setup:retry': {} as Contract<[id: string], OvenSetupOperation>,
  'oven:harness:inventory': {} as Contract<[id: string], OvenHarnessInventoryItem[]>,
  'oven:timezone:sync': {} as Contract<[id: string], OvenTimezoneSyncResult>,
  'oven:harness:update': {} as Contract<[id: string, harnessId: string], OvenHarnessInventoryItem>,
  'oven:harness:uninstall': {} as Contract<
    [id: string, harnessId: string],
    OvenHarnessInventoryItem
  >,
  'oven:agent:script': {} as Contract<[input: OvenAgentScriptRequest], OvenAgentScript>,
  'oven:agent:preview': {} as Contract<[code: string], OvenAgentPreview>,
  'oven:agent:reachable': {} as Contract<[code: string], string | null>,
  'oven:agent:register': {} as Contract<[input: OvenAgentRegistrationInput], OvenAgentRegistration>
}
