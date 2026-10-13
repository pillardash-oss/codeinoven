import { invoke, subscribe } from '$lib/ipc.svelte'
import { reportError } from '$lib/stores/app-errors.svelte'

class CustomVendorIcons {
  icons = $state.raw<Record<string, string>>({})
  private loading: Promise<void> | undefined
  private subscribed = false

  load(): Promise<void> {
    if (!this.subscribed) {
      this.subscribed = true
      subscribe('customVendors:iconChanged', ({ providerId, icon }) => {
        this.icons = { ...this.icons, [providerId]: icon }
      })
    }
    return (this.loading ??= this.read())
  }

  private async read(): Promise<void> {
    try {
      const icons = await invoke('customVendors:listIcons')
      this.icons = { ...icons, ...this.icons }
    } catch (error) {
      this.loading = undefined
      reportError(error, 'Failed to load custom vendor icons.')
    }
  }

  get(id: string | undefined): string | undefined {
    return id ? this.icons[id] : undefined
  }

  async save(id: string, image: string): Promise<void> {
    await this.load()
    const icon = await invoke('customVendors:saveIcon', id, image)
    this.icons = { ...this.icons, [id]: icon }
  }
}

export const customVendorIcons = new CustomVendorIcons()
