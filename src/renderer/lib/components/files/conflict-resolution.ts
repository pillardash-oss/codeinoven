export interface ConflictResolutionStatus {
  canSave: boolean
  dirty: boolean
  saving: boolean
}

export interface ConflictResolutionController {
  save(): Promise<boolean>
}
