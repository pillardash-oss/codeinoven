import { invoke } from '$lib/ipc.svelte'
import type { DesignExportFormat, DesignExportResult } from '$shared/design/design-export'
import { logRendererError } from '$lib/system/renderer-logger'

class DesignExportState {
  open = $state(false)
  minimized = $state(false)
  running = $state(false)
  label = $state('')
  error = $state('')
  result = $state<DesignExportResult | null>(null)
  private mounted = false

  async start(
    projectId: string,
    directory: string,
    entry: string | null,
    format: DesignExportFormat
  ): Promise<void> {
    if (this.running) {
      this.open = true
      this.minimized = false
      return
    }
    if (!this.mounted) {
      const [{ mount }, { default: DesignExportProgress }] = await Promise.all([
        import('svelte'),
        import('$lib/components/design/DesignExportProgress.svelte')
      ])
      if (!this.mounted) {
        mount(DesignExportProgress, { target: document.body })
        this.mounted = true
      }
    }
    if (this.running) {
      this.open = true
      this.minimized = false
      return
    }
    this.open = true
    this.minimized = false
    this.running = true
    this.error = ''
    this.result = null
    this.label = `${entry ?? 'Whole design'} as ${format.toUpperCase()}`
    try {
      this.result = await invoke('design:export', projectId, directory, entry, format)
    } catch (error: unknown) {
      logRendererError('Design export failed.', error)
      this.error = error instanceof Error ? error.message : 'The design could not be exported.'
    } finally {
      this.running = false
    }
  }
}
export const designExportState = new DesignExportState()
