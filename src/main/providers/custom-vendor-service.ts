import { Buffer } from 'node:buffer'
import {
  MAX_CUSTOM_VENDOR_ICON_BYTES,
  isCustomVendorIconType,
  type CustomVendorIconSet,
  type CustomVendorIconVariant
} from '../../lib/custom-vendor-icon'
import type { StorageEngine } from '../storage/storage-engine'

interface CustomVendor {
  providerId: string
  /** Light-theme artwork. The only variant before dark artwork existed. */
  icon?: string
  /** Dark-theme artwork; falls back to `icon` wherever it is used. */
  iconDark?: string
}

/** Artwork is app-owned, independent of harness-native config and source files. */
export class CustomVendorService {
  constructor(private readonly storage: StorageEngine) {}

  async list(): Promise<Record<string, CustomVendorIconSet>> {
    const icons: Record<string, CustomVendorIconSet> = {}
    for (const file of await this.storage.list('custom-vendors')) {
      if (!/^[a-zA-Z0-9._%-]+\.json$/u.test(file)) continue
      const vendor = await this.storage.read<CustomVendor>(`custom-vendors/${file}`)
      if (!vendor || typeof vendor.providerId !== 'string') continue
      const set: CustomVendorIconSet = {}
      if (typeof vendor.icon === 'string') set.light = validateCustomVendorIcon(vendor.icon)
      if (typeof vendor.iconDark === 'string') set.dark = validateCustomVendorIcon(vendor.iconDark)
      if (set.light || set.dark) icons[vendor.providerId] = set
    }
    return icons
  }

  /**
   * Save or clear one theme's artwork.
   *
   * `null` clears that variant while keeping the other, so a user can drop dark
   * artwork and fall back to the light image instead of losing both.
   */
  async save(
    providerId: string,
    icon: unknown,
    variant: CustomVendorIconVariant = 'light'
  ): Promise<CustomVendorIconSet> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(providerId)) {
      throw new TypeError('Invalid custom vendor provider ID')
    }
    const path = `custom-vendors/${encodeURIComponent(providerId)}.json`
    const existing = await this.storage.read<CustomVendor>(path).catch(() => null)
    const set: CustomVendorIconSet = {
      ...(existing?.icon ? { light: existing.icon } : {}),
      ...(existing?.iconDark ? { dark: existing.iconDark } : {})
    }
    if (icon === null) delete set[variant]
    else set[variant] = validateCustomVendorIcon(icon)
    if (!set.light && !set.dark) {
      await this.storage.remove(path).catch(() => undefined)
      return {}
    }
    await this.storage.write(path, {
      providerId,
      ...(set.light ? { icon: set.light } : {}),
      ...(set.dark ? { iconDark: set.dark } : {})
    } satisfies CustomVendor)
    return set
  }
}

export function validateCustomVendorIcon(value: unknown): string {
  if (typeof value !== 'string' || value.length > (MAX_CUSTOM_VENDOR_ICON_BYTES * 4) / 3 + 128) {
    throw new TypeError('Vendor icon must be an image of at most 256 KiB')
  }
  const match = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value)
  if (!match || !isCustomVendorIconType(match[1])) {
    throw new TypeError('Choose an SVG, PNG, JPEG, WebP or GIF image')
  }
  const bytes = Buffer.from(match[2], 'base64')
  if (
    !bytes.length ||
    bytes.length > MAX_CUSTOM_VENDOR_ICON_BYTES ||
    bytes.toString('base64') !== match[2]
  ) {
    throw new TypeError('Invalid vendor image data')
  }
  const type = match[1]
  const valid =
    type === 'image/svg+xml'
      ? /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/u.test(bytes.toString('utf8'))
      : type === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : type === 'image/jpeg'
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : type === 'image/webp'
            ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
            : /^GIF8[79]a$/u.test(bytes.toString('ascii', 0, 6))
  if (!valid) throw new TypeError('Vendor icon content does not match its image type')
  return value
}
