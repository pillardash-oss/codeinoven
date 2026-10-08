/** App-owned setup launcher. Once loaded, the host survives view navigation. */
class OvenSetupStore {
  initialized = $state(false)
  open = $state(false)
  ovenId = $state('')
  completed = $state<Record<string, boolean>>({})

  show(ovenId: string): void {
    this.ovenId = ovenId
    this.initialized = true
    this.open = true
  }

  close(): void {
    this.open = false
  }

  markComplete(ovenId: string): void {
    this.completed = { ...this.completed, [ovenId]: true }
  }
}

export const ovenSetupStore = new OvenSetupStore()
