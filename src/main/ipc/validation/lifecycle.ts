import type {
  EngineeringLifecycleDecision,
  EngineeringLifecycleSelection,
  EngineeringLifecycleStage
} from '../../../lib/types'
import { assertEnum, validateBoundedString } from './primitives'

const ENGINEERING_LIFECYCLE_SELECTIONS = new Set<EngineeringLifecycleSelection>([
  'none',
  'brainstorm',
  'prd',
  'spec',
  'assignment',
  'achievement',
  'run_all'
])
const ENGINEERING_LIFECYCLE_DECISIONS = new Set<EngineeringLifecycleDecision>([
  'continue',
  'continue_without_hifi',
  'retry',
  'cancel'
])
const ENGINEERING_LIFECYCLE_STAGES = new Set<EngineeringLifecycleStage>([
  'brainstorm',
  'prd',
  'spec',
  'assignment',
  'achievement'
])

export function validateEngineeringLifecycleSelection(
  value: unknown
): EngineeringLifecycleSelection {
  return assertEnum(value, ENGINEERING_LIFECYCLE_SELECTIONS, 'engineering lifecycle selection')
}

export function validateEngineeringLifecycleSelectionInput(value: unknown): {
  stages: EngineeringLifecycleStage[]
  autopilot: boolean
} {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Engineering lifecycle selection must be an object')
  }
  const record = value as Record<string, unknown>
  const rawStages = record.stages
  const stages = Array.isArray(rawStages)
    ? rawStages
        .map((stage) => validateEngineeringLifecycleStage(stage))
        .filter(
          (stage, index, all): stage is EngineeringLifecycleStage => all.indexOf(stage) === index
        )
    : []
  return { stages, autopilot: record.autopilot === true }
}

export function validateEngineeringLifecycleDecision(value: unknown): EngineeringLifecycleDecision {
  return assertEnum(value, ENGINEERING_LIFECYCLE_DECISIONS, 'engineering lifecycle decision')
}

export function validateEngineeringLifecycleStage(value: unknown): EngineeringLifecycleStage {
  return assertEnum(value, ENGINEERING_LIFECYCLE_STAGES, 'engineering lifecycle stage')
}

export function validateEngineeringLifecycleResumeToken(value: unknown): string {
  return validateBoundedString(value, 'Engineering lifecycle resume token', 1, 256)
}
