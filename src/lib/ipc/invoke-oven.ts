import type {
  Oven,
  OvenState,
  OvenProbe,
  SaveOvenInput,
  OvenRun,
  OvenWorkspaceRequest,
  OvenWorkspaceResult,
  OvenTransferInput,
  OvenTransferReview
} from '../ovens'
import type { Contract } from './contract-helpers'
import type { Thread } from '../types'

export const invokeOvenContract = {
  'oven:state': {} as Contract<[], OvenState>,
  'oven:save': {} as Contract<[input: SaveOvenInput], Oven>,
  'oven:remove': {} as Contract<[id: string], OvenState>,
  'oven:setDefault': {} as Contract<[id: string], OvenState>,
  'oven:install': {} as Contract<[id: string], OvenProbe>,
  'oven:probe': {} as Contract<[id: string], OvenProbe>,
  'oven:runs': {} as Contract<[id: string], OvenRun[]>,
  'oven:workspace': {} as Contract<[id: string, input: OvenWorkspaceRequest], OvenWorkspaceResult>,
  'oven:reviewTransfer': {} as Contract<[input: OvenTransferInput], OvenTransferReview>,
  'oven:transfer': {} as Contract<[reviewId: string], OvenTransferReview>,
  'oven:preview': {} as Contract<[id: string, root: string], string>,
  'oven:selectThread': {} as Contract<
    [projectId: string, threadId: string, id: string, root?: string],
    Thread
  >
}
