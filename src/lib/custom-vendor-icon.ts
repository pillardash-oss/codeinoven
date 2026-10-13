/** Keep vendor artwork small enough to share across every model row. */
export const MAX_CUSTOM_VENDOR_ICON_BYTES = 256 * 1024
export const CUSTOM_VENDOR_ICON_TYPES = [
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
] as const

export function isCustomVendorIconType(value: string): boolean {
  return CUSTOM_VENDOR_ICON_TYPES.some((type) => type === value)
}
