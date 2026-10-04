export interface SetupStep {
  id: string
  name: string
  action: () => Promise<void>
  requiresElevation?: boolean
}

export interface SetupContext {
  platform: string
  architecture: string
  packageManager: 'apt' | 'brew' | 'winget' | 'unknown'
  hasNode: boolean
  nodeVersion: string | null
  hasGit: boolean
  hasCurl: boolean
  selectedHarnesses: string[]
  packageUpgrades: boolean
}

export class OvenSetupScript {
  steps: SetupStep[] = []
  context: SetupContext

  constructor(context: SetupContext) {
    this.context = context
  }

  addStep(step: SetupStep) {
    this.steps.push(step)
  }

  async run(): Promise<void> {
    for (const step of this.steps) {
      await step.action()
    }
  }
}
