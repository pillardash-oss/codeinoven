import { invoke, subscribe } from '$lib/ipc.svelte'
import { reportError } from '$lib/stores/app-errors.svelte'
import { schemeState } from '$lib/stores/scheme.svelte'
import type { CustomVendorIconSet, CustomVendorIconVariant } from '$shared/custom-vendor-icon'

/**
 * Saved artwork for the custom base-URL vendors, one image per theme.
 *
 * A vendor may have light artwork only, dark artwork only, or both: whichever
 * theme is missing falls back to the other, and a vendor with neither keeps the
 * mark the app ships for it.
 */
class CustomVendorIcons {
  icons = $state.raw<Record<string, CustomVendorIconSet>>({})
  private loading: Promise<void> | undefined
  private subscribed = false

  load(): Promise<void> {
    if (!this.subscribed) {
      this.subscribed = true
      subscribe('customVendors:iconChanged', ({ providerId, icons }) => {
        this.icons = { ...this.icons, [providerId]: icons }
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

  /** Saved artwork for one theme, falling back to the other theme's image. */
  get(
    id: string | undefined,
    theme: 'light' | 'dark' = schemeState.isDark ? 'dark' : 'light'
  ): string | undefined {
    if (!id) return undefined
    const set = this.icons[id]
    if (!set) return undefined
    return theme === 'dark' ? (set.dark ?? set.light) : (set.light ?? set.dark)
  }

  /** Either theme's artwork, for a caller that only needs "is there one". */
  has(id: string | undefined): boolean {
    if (!id) return false
    const set = this.icons[id]
    return Boolean(set?.light || set?.dark)
  }

  async save(id: string, image: string | null, variant: CustomVendorIconVariant): Promise<void> {
    await this.load()
    const icons = await invoke('customVendors:saveIcon', id, image, variant)
    this.icons = { ...this.icons, [id]: icons }
  }
}

export const customVendorIcons = new CustomVendorIcons()
