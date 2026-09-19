import type { CapturableSpecContextType, ProjectFileEntry } from '$shared/types'

export type ContextPickerType = Exclude<CapturableSpecContextType, 'attachment'>

export interface SpecStudioContextPickerDeps {
  search: (type: ContextPickerType, query: string) => Promise<ProjectFileEntry[]>
}

const SEARCH_DEBOUNCE_MS = 160

/**
 * Reactive state machine behind the specification context picker: the open
 * picker type, its debounced project search, and the result/loading/error
 * triples the picker renders.
 */
export class SpecStudioContextPickerController {
  pickerType = $state<ContextPickerType | null>(null)
  query = $state('')
  results = $state<ProjectFileEntry[]>([])
  busy = $state(false)
  error = $state('')

  private request = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly deps: SpecStudioContextPickerDeps) {}

  async open(type: ContextPickerType): Promise<void> {
    this.pickerType = type
    this.query = ''
    this.results = []
    this.error = ''
    await this.runSearch(type, '')
  }

  close(): void {
    clearTimeout(this.timer)
    this.request += 1
    this.pickerType = null
    this.query = ''
    this.results = []
    this.busy = false
    this.error = ''
  }

  handleQueryInput(value: string): void {
    if (!this.pickerType) return
    this.query = value
    clearTimeout(this.timer)
    const type = this.pickerType
    this.timer = setTimeout(() => void this.runSearch(type, this.query), SEARCH_DEBOUNCE_MS)
  }

  dispose(): void {
    clearTimeout(this.timer)
  }

  private async runSearch(type: ContextPickerType, query: string): Promise<void> {
    const request = ++this.request
    this.busy = true
    this.error = ''
    try {
      const results = await this.deps.search(type, query)
      if (request === this.request) this.results = results
    } catch (error) {
      if (request === this.request) {
        this.results = []
        this.error = error instanceof Error ? error.message : 'Project files could not be searched.'
      }
    } finally {
      if (request === this.request) this.busy = false
    }
  }
}
