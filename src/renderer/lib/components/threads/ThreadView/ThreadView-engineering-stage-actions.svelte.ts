import type { EngineeringLifecycleStage } from '$shared/types'
import type { ThreadView } from './ThreadView-board.svelte'
/** One concern of the ThreadView board. */
export class ThreadViewEngineeringStageActions {
  #root: ThreadView | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ThreadView {
    if (!this.#root)
      throw new Error('ThreadViewEngineeringStageActions read its board before it was bound')
    return this.#root
  }
  constructor(root: ThreadView) {
    this.#root = root
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
