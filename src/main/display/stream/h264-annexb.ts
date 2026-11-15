/**
 * The few things the stream needs to know about an H.264 Annex B payload.
 *
 * The device's encoder already produced a bitstream the browser's decoder reads, so
 * nothing here decodes or rewrites it: it finds the NAL units to read the codec
 * string out of the SPS, and that is all.
 */

export interface NalUnit {
  /** NAL unit type, the low five bits of its header byte. */
  type: number
  /** Offset of the NAL header byte, just past its start code. */
  offset: number
}

const NAL_TYPE_SPS = 7

/** Every NAL unit in an Annex B buffer, found by its `00 00 01` start code. */
export function findNalUnits(data: Uint8Array): NalUnit[] {
  const units: NalUnit[] = []
  for (let index = 0; index + 3 < data.length; index += 1) {
    if (data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1) {
      units.push({ type: (data[index + 3] ?? 0) & 0x1f, offset: index + 3 })
      index += 2
    }
  }
  return units
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0')
}

/**
 * The WebCodecs codec string (`avc1.PPCCLL`) for a config packet, or null when it
 * carries no usable SPS.
 */
export function avcCodecString(config: Uint8Array): string | null {
  for (const unit of findNalUnits(config)) {
    if (unit.type !== NAL_TYPE_SPS) continue
    const profile = config[unit.offset + 1]
    const constraints = config[unit.offset + 2]
    const level = config[unit.offset + 3]
    if (profile === undefined || constraints === undefined || level === undefined) return null
    return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`
  }
  return null
}

/** Two buffers as one, for putting the parameter sets in front of a key frame. */
export function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(first.length + second.length)
  joined.set(first, 0)
  joined.set(second, first.length)
  return joined
}
