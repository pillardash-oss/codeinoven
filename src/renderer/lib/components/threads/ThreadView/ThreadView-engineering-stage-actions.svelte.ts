import type { EngineeringLifecycleStage } from '$shared/types'
import type { ThreadView } from './ThreadView-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewEngineeringStageActions extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }
  /** Engineering lifecycle stages exposed as individual action-menu toggles.
   *  Mirrors the Engineering Toolbox rows so both surfaces stay in sync. */
  engineeringStageActions: ReadonlyArray<{
    stage: EngineeringLifecycleStage
    label: string
    description: string
    keywords: string[]
  }> = [
    {
      stage: 'brainstorm',
      label: 'Brainstorm',
      description: 'Research, prototype and align your vision.',
      keywords: ['brainstorm', 'research', 'vision']
    },
    {
      stage: 'prd',
      label: 'PRD',
      description: 'Define product requirements, usecases and outcomes.',
      keywords: ['prd', 'product', 'requirements']
    },
    {
      stage: 'spec',
      label: 'Spec',
      description: 'Create an implementation-ready contract.',
      keywords: ['spec', 'specification', 'contract']
    },
    {
      stage: 'assignment',
      label: 'Assignment',
      description: 'Break up your tasks & assign to worker agents.',
      keywords: ['assignment', 'coordinator', 'workers', 'parallel']
    },
    {
      stage: 'achievement',
      label: 'Achievement',
      description: 'Spec, Implement, Audit and rework until complete.',
      keywords: ['achievement', 'loop', 'goal', 'audit', 'implementation']
    }
  ]
}
