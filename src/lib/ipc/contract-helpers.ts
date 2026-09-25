import type {
  AssignmentProvenance,
  BrainstormProvenance,
  PrdProvenance,
  SpecProvenance
} from '../types'

export type Contract<Args extends unknown[], Result> = {
  args: Args
  result: Result
}

export type NewSpecProvenance = Omit<SpecProvenance, 'createdAt' | 'parentVersion'>

export type NewBrainstormProvenance = Omit<BrainstormProvenance, 'createdAt' | 'parentVersion'>

export type NewPrdProvenance = Omit<PrdProvenance, 'createdAt' | 'parentVersion'>

export type NewAssignmentProvenance = Omit<AssignmentProvenance, 'createdAt' | 'parentVersion'>
