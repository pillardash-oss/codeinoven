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
 * The conflict editor's two outcomes, each with its own control: saving a draft
 * keeps the merge in progress, and marking the file resolved stages the
 * finished content. Neither waits on the other, so a file can be resolved
 * without a draft write, and a draft can be saved without resolving anything.
 */
export type ConflictSaveAction = 'draft' | 'resolve'

/** The fixed text on each conflict save control. */
export const conflictSaveActionLabels: Record<ConflictSaveAction, string> = {
  draft: 'Save as draft',
  resolve: 'Mark as resolved'
}

/** The sentence behind a conflict save control, for its `title` and `aria-label`. */
export function conflictSaveActionTitle(action: ConflictSaveAction): string {
  return action === 'draft'
    ? 'Save the resolved progress as a draft; the file stays conflicted'
    : 'Replace the original file with the resolved content and mark it resolved'
}

/**
 * What a Cmd/Ctrl+S press does for a conflicted file.
 *
 * The chord keeps a rule of its own, unlike the two buttons: it writes the
 * resolved progress as a draft first, and only a press with no draft left to
 * write hands the finished file back to git, so one press can never stage a
 * file whose resolved progress the scratch file has not seen.
 */
export type ConflictSaveStep = 'draft' | 'resolve' | 'none'

export function conflictSaveStep(
  status: Pick<ConflictResolutionStatus, 'canSave' | 'canSaveDraft'>
): ConflictSaveStep {
  if (status.canSaveDraft) return 'draft'
  if (status.canSave) return 'resolve'
  return 'none'
}
