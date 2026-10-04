export interface SetupStep {
  id: string
  name: string
  action: () => Promise<void>
}

export class OvenSetupScript {
  steps: SetupStep[] = []

  addStep(step: SetupStep) {
    this.steps.push(step)
  }

  async run() {
    for (const step of this.steps) {
      await step.action()
    }
  }
}
