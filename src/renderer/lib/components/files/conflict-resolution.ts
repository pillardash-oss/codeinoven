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

/**
 * What a save press does for a conflicted file right now.
 *
 * `draft` writes the resolved progress into the conflict scratch file, `resolve`
 * replaces the working file with the resolved content and stages it, and `none`
 * means there is nothing to persist yet.
 */
export type ConflictSaveStep = 'draft' | 'resolve' | 'none'

/**
 * The one rule every conflict save control follows: resolved progress that the
 * scratch file has not taken yet is written as a draft first, and only a press
 * with no draft left to write hands the finished file back to git. The chord,
 * the panel's save button, and the editor's own save button all read this, so
 * none of them can mark a file resolved on the press that drafts it.
 */
export function conflictSaveStep(
  status: Pick<ConflictResolutionStatus, 'canSave' | 'canSaveDraft'>
): ConflictSaveStep {
  if (status.canSaveDraft) return 'draft'
  if (status.canSave) return 'resolve'
  return 'none'
}

/** The button text: the step the press performs. */
export function conflictSaveStepLabel(step: ConflictSaveStep): string {
  return step === 'resolve' ? 'Mark as resolved' : 'Save draft'
}

/** The sentence behind the button, for its `title` and `aria-label`. */
export function conflictSaveStepTitle(step: ConflictSaveStep): string {
  if (step === 'draft') {
    return 'Save the resolved progress to the conflict scratch file (Cmd/Ctrl+S)'
  }
  if (step === 'resolve') {
    return 'Replace the original file with the resolved content and mark it resolved (Cmd/Ctrl+S)'
  }
  return 'Accept a conflict block first: a draft needs at least one resolved block'
}
