export interface ConflictResolutionStatus {
  canSave: boolean
  /** Resolved progress exists that the scratch file does not hold yet: the save
   *  chord writes it as a draft before it can mark the file resolved. */
  canSaveDraft: boolean
  dirty: boolean
  saving: boolean
}

export interface ConflictResolutionController {
  save(): Promise<boolean>
  saveDraft(): Promise<boolean>
}
