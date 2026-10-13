import { Buffer } from 'node:buffer'
import { MAX_CUSTOM_VENDOR_ICON_BYTES, isCustomVendorIconType } from '../../lib/custom-vendor-icon'
import type { StorageEngine } from '../storage/storage-engine'

interface CustomVendor {
  providerId: string
  icon: string
}

/** Artwork is app-owned, independent of harness-native config and source files. */
export class CustomVendorService {
  constructor(private readonly storage: StorageEngine) {}

  async list(): Promise<Record<string, string>> {
    const icons: Record<string, string> = {}
    for (const file of await this.storage.list('custom-vendors')) {
      if (!/^[a-zA-Z0-9._%-]+\.json$/u.test(file)) continue
      const vendor = await this.storage.read<CustomVendor>(`custom-vendors/${file}`)
      if (vendor && typeof vendor.providerId === 'string' && typeof vendor.icon === 'string') {
        icons[vendor.providerId] = validateCustomVendorIcon(vendor.icon)
      }
    }
    return icons
  }

  async save(providerId: string, icon: unknown): Promise<string> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(providerId)) {
      throw new TypeError('Invalid custom vendor provider ID')
    }
    const validated = validateCustomVendorIcon(icon)
    await this.storage.write(`custom-vendors/${encodeURIComponent(providerId)}.json`, {
      providerId,
      icon: validated
    } satisfies CustomVendor)
    return validated
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
