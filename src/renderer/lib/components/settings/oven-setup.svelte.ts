export interface OvenSetupState {
  open: boolean
  step: 'preflight' | 'configure' | 'running' | 'complete'
}

export function createOvenSetupState(): OvenSetupState {
  return {
    open: false,
    step: 'preflight'
  }
}
