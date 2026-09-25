import type { EngineeringSpec } from '$shared/types'

export type SpecStringField =
  'problem' | 'resolutionSummary' | 'testStrategy' | 'additionalInfo' | 'commitPattern'

export type SpecArrayField =
  'successCriteria' | 'documentationRequirements' | 'constraints' | 'risks'

export type SpecPhaseField = 'title' | 'objective' | 'commit'
export type SpecCheckpointField = 'description' | 'evidence'
export type SpecFileOperationField = 'path' | 'reason' | 'operation'

/**
 * Mutation surface handed to the document renderers. Every call is expected to
 * mark the spec dirty in the owning component; the functions here stay pure
 * with respect to reactivity and only touch the passed draft.
 */
export interface SpecDraftEdits {
  setString(key: SpecStringField, value: string): void
  setArrayItem(key: SpecArrayField, index: number, value: string): void
  addArrayItem(key: SpecArrayField): void
  removeArrayItem(key: SpecArrayField, index: number): void
  addPhase(): void
  removePhase(phaseId: string): void
  addCheckpoint(phaseId: string): void
  addFileOperation(phaseId: string): void
  setPhaseField(phaseId: string, field: SpecPhaseField, value: string): void
  setCheckpointField(
    phaseId: string,
    checkpointId: string,
    field: SpecCheckpointField,
    value: string
  ): void
  setFileOperationField(
    phaseId: string,
    index: number,
    field: SpecFileOperationField,
    value: string
  ): void
}

export function setSpecString(draft: EngineeringSpec, key: SpecStringField, value: string): void {
  draft.content[key] = value
}

export function setSpecArrayItem(
  draft: EngineeringSpec,
  key: SpecArrayField,
  index: number,
  value: string
): void {
  draft.content[key][index] = value
}

export function addSpecArrayItem(draft: EngineeringSpec, key: SpecArrayField): void {
  draft.content[key] = [...draft.content[key], 'New item']
}

export function removeSpecArrayItem(
  draft: EngineeringSpec,
  key: SpecArrayField,
  index: number
): void {
  draft.content[key] = draft.content[key].filter((_, itemIndex) => itemIndex !== index)
}

export function addSpecPhase(draft: EngineeringSpec): void {
  const ordinal = draft.content.phases.length + 1
  draft.content.phases.push({
    id: crypto.randomUUID(),
    title: `Phase ${ordinal}`,
    objective: 'Describe the phase objective.',
    checkpoints: [],
    fileOperations: [],
    commit: ''
  })
}

export function removeSpecPhase(draft: EngineeringSpec, phaseId: string): void {
  draft.content.phases = draft.content.phases.filter((candidate) => candidate.id !== phaseId)
}

export function addSpecCheckpoint(draft: EngineeringSpec, phaseId: string): void {
  const phase = draft.content.phases.find((candidate) => candidate.id === phaseId)
  if (!phase) return
  phase.checkpoints.push({
    id: crypto.randomUUID(),
    description: 'Describe the checkpoint.',
    evidence: 'Describe the required evidence.'
  })
}

export function addSpecFileOperation(draft: EngineeringSpec, phaseId: string): void {
  const phase = draft.content.phases.find((candidate) => candidate.id === phaseId)
  if (!phase) return
  phase.fileOperations.push({
    path: 'project/relative/path',
    operation: 'edit',
    reason: 'Reason'
  })
}

export function setSpecPhaseField(
  draft: EngineeringSpec,
  phaseId: string,
  field: SpecPhaseField,
  value: string
): void {
  const phase = draft.content.phases.find((candidate) => candidate.id === phaseId)
  if (!phase) return
  phase[field] = value
}

export function setSpecCheckpointField(
  draft: EngineeringSpec,
  phaseId: string,
  checkpointId: string,
  field: SpecCheckpointField,
  value: string
): void {
  const checkpoint = draft.content.phases
    .find((candidate) => candidate.id === phaseId)
    ?.checkpoints.find((candidate) => candidate.id === checkpointId)
  if (!checkpoint) return
  checkpoint[field] = value
}

export function setSpecFileOperationField(
  draft: EngineeringSpec,
  phaseId: string,
  index: number,
  field: SpecFileOperationField,
  value: string
): void {
  const operation = draft.content.phases.find((candidate) => candidate.id === phaseId)
    ?.fileOperations[index]
  if (!operation) return
  if (field === 'operation') {
    if (value === 'create' || value === 'edit' || value === 'delete') operation.operation = value
    return
  }
  operation[field] = value
}
