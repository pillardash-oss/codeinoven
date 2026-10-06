import type {
  CioCleanupExclusionToggleInput,
  CioCleanupExclusionToggleResult,
  CioCleanupState
} from '../types/cio-cleanup'
import type { Contract } from './contract-helpers'

/** One run's identity, and whether this call started it or surfaced a live one. */
export interface CioCleanupRunStart {
  runId: string
  started: boolean
}

export const invokeCioCleanupContract = {
  'cioCleanup:state': {} as Contract<[], CioCleanupState>,
  'cioCleanup:run': {} as Contract<[], CioCleanupRunStart>,
  'cioCleanup:cancel': {} as Contract<[runId: string], void>,
  'cioCleanup:toggleExclusion': {} as Contract<
    [input: CioCleanupExclusionToggleInput],
    CioCleanupExclusionToggleResult
  >
}
