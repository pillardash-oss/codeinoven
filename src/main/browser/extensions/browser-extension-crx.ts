/**
 * Reading a Chrome Web Store `.crx` file, and the identity rules that make the
 * result the publisher's real extension rather than a copy of it.
 *
 * Two facts decide the whole design:
 *
 *   1. `ses.extensions.loadExtension` refuses a packed file outright, so a CRX
 *      has to be unwrapped before Electron will look at it. The ZIP payload is
 *      identified by the Cr24 header, never assumed to start at a fixed offset.
 *   2. An unpacked extension's id is a hash of its install path, so the same
 *      extension unpacked twice is two different extensions with two different
 *      storage areas. The only way to keep the official id, and therefore the id
 *      an extension's own cloud features and documentation name, is to pin the
 *      publisher's public key as `key` in the manifest. Chromium derives the id
 *      from that key exactly as it derives it from the store's copy, and the
 *      derivation is reproduced here for CRX3 by walking the header's protobuf:
 *      proof #2 is the publisher's RSA key, and the id is the first 16 bytes of
 *      its SHA-256, each nibble mapped onto `a`..`p`.
 *
 * A CRX3 header carries several proofs (Google's store key, the publisher's key,
 * an ECDSA store key), so the proof is chosen by matching the id the Web Store
 * declared, never by position. Falling back to "the first proof" would silently
 * install an extension under Google's id.
 *
 * Every buffer read here is bounded: a header claims its own length in its header,
 * so a corrupt file could otherwise ask for an unbounded allocation.
 */

import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import {
  isWebstoreExtensionId,
  webstoreExtensionIdFromInput
} from '../../../lib/browser/browser-webstore'

export const CRX_MAGIC = 'Cr24'

/** Cr24 version that carries a protobuf header with per-proof keys. */
export const CRX3_VERSION = 3

/** magic(4) + version(4) + declared header length(4). */
const CRX_PREFIX_BYTES = 12

/** A header larger than this is not something the Web Store produces, and reading
 *  it is how one corrupt file becomes a multi-gigabyte allocation. */
const MAX_CRX_HEADER_BYTES = 1 << 20

/** Protobuf wire types this reader understands. */
const WIRE_VARINT = 0
const WIRE_FIXED64 = 1
const WIRE_LENGTH = 2
const WIRE_FIXED32 = 5

export interface CrxHeader {
  version: number
  /** The header length the file declares. */
  headerLength: number
  /** Byte offset the ZIP payload starts at. */
  payloadOffset: number
  /** The publisher's public key (SubjectPublicKeyInfo), or null when no proof in
   *  the header derived a usable id. */
  publicKey: Buffer | null
  /** The id the chosen proof derives, or null when none could be read. */
  id: string | null
  /** The number of key proofs the header carried, so a caller can report an odd
   *  file rather than guess. */
  proofCount: number
}

interface ProtoField {
  fieldNumber: number
  wireType: number
  /** Raw bytes for a length-delimited field, or the varint value. */
  bytes: Buffer | null
  value: bigint
}

/** True for a well-formed Chromium extension id. The pattern itself lives in the
 *  shared parser, so the service and the browser chrome agree on what an id is. */
export function isExtensionId(value: unknown): value is string {
  return typeof value === 'string' && isWebstoreExtensionId(value)
}

/** The Web Store id in whatever the user pasted, from the shared parser: a bare
 *  id, a store URL, or a URL with an `id` query parameter. Re-exported so the
 *  service keeps one import for every identity rule it enforces. */
export { webstoreExtensionIdFromInput as extensionIdFromInput }

/** The id Chromium derives from a public key: the first 16 bytes of its SHA-256,
 *  each nibble shifted onto `a`..`p`. */
export function deriveExtensionId(publicKey: Buffer): string {
  const digest = createHash('sha256').update(publicKey).digest()
  let id = ''
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4))
    id += String.fromCharCode(97 + (byte & 0x0f))
  }
  return id
}

/** The id a manifest `key` pins, or null when it is not usable base64. */
export function extensionIdFromManifestKey(manifestKey: unknown): string | null {
  if (typeof manifestKey !== 'string' || manifestKey.length === 0) return null
  if (manifestKey.length > 8192) return null
  try {
    return deriveExtensionId(Buffer.from(manifestKey, 'base64'))
  } catch {
    return null
  }
}

function readVarint(buffer: Buffer, start: number, end: number): { value: bigint; next: number } {
  let value = 0n
  let shift = 0n
  let position = start
  for (;;) {
    if (position >= end) throw new Error('CRX header varint runs past the header')
    const byte = buffer[position] ?? 0
    position += 1
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7n
    if (shift > 63n) throw new Error('CRX header varint is too long')
  }
  return { value, next: position }
}

/** Parse one protobuf message into its top-level fields. Only the wire types a
 *  CRX3 header actually uses are supported; anything else is a corrupt file. */
function parseProtoFields(buffer: Buffer, start: number, end: number): ProtoField[] {
  const fields: ProtoField[] = []
  let position = start
  while (position < end) {
    const key = readVarint(buffer, position, end)
    position = key.next
    const fieldNumber = Number(key.value >> 3n)
    const wireType = Number(key.value & 7n)
    if (wireType === WIRE_VARINT) {
      const read = readVarint(buffer, position, end)
      position = read.next
      fields.push({ fieldNumber, wireType, bytes: null, value: read.value })
    } else if (wireType === WIRE_FIXED64) {
      if (position + 8 > end) throw new Error('CRX header runs past the header')
      fields.push({
        fieldNumber,
        wireType,
        bytes: buffer.subarray(position, position + 8),
        value: 0n
      })
      position += 8
    } else if (wireType === WIRE_LENGTH) {
      const length = readVarint(buffer, position, end)
      position = length.next
      const size = Number(length.value)
      if (size < 0 || position + size > end)
        throw new Error('CRX header field runs past the header')
      fields.push({
        fieldNumber,
        wireType,
        bytes: buffer.subarray(position, position + size),
        value: 0n
      })
      position += size
    } else if (wireType === WIRE_FIXED32) {
      if (position + 4 > end) throw new Error('CRX header runs past the header')
      fields.push({
        fieldNumber,
        wireType,
        bytes: buffer.subarray(position, position + 4),
        value: 0n
      })
      position += 4
    } else {
      throw new Error(`CRX header uses an unsupported protobuf wire type (${wireType})`)
    }
  }
  return fields
}

/**
 * Parse a Cr24 prefix and header.
 *
 * `expectedId` is the Web Store id the caller asked for. When it is known, the
 * proof that derives it is the one used; when it is not, the first proof that
 * derives a well-formed id is, and the caller can compare afterwards.
 */
export function parseCrxHeader(
  prefix: Buffer,
  header: Buffer,
  expectedId: string | null
): CrxHeader {
  if (prefix.length < CRX_PREFIX_BYTES) throw new Error('the file is too short to be a CRX')
  if (prefix.subarray(0, 4).toString('latin1') !== CRX_MAGIC) {
    throw new Error('the file is not a CRX (its magic bytes are missing)')
  }
  const version = prefix.readUInt32LE(4)
  const headerLength = prefix.readUInt32LE(8)
  if (version !== CRX3_VERSION) {
    throw new Error(`CRX version ${version} is not supported, only version 3 is`)
  }
  if (headerLength === 0 || headerLength > MAX_CRX_HEADER_BYTES) {
    throw new Error(`the CRX header length (${headerLength}) is not credible`)
  }
  if (header.length !== headerLength) {
    throw new Error('the CRX header is shorter than the length it declares')
  }

  // Field 2 carries RSA proofs, field 3 carries ECDSA proofs. Each holds the
  // public key in field 1 and its signature in field 2.
  const proofs: Buffer[] = []
  for (const field of parseProtoFields(header, 0, header.length)) {
    if (field.wireType !== WIRE_LENGTH) continue
    if (field.fieldNumber !== 2 && field.fieldNumber !== 3) continue
    if (!field.bytes) continue
    const inner = parseProtoFields(field.bytes, 0, field.bytes.length)
    const publicKey = inner.find((candidate) => candidate.fieldNumber === 1 && candidate.bytes)
    if (publicKey?.bytes && publicKey.bytes.length > 0) proofs.push(publicKey.bytes)
  }

  let publicKey: Buffer | null = null
  let id: string | null = null
  for (const candidate of proofs) {
    const candidateId = deriveExtensionId(candidate)
    if (!isExtensionId(candidateId)) continue
    if (expectedId && candidateId !== expectedId) continue
    publicKey = candidate
    id = candidateId
    break
  }
  // No id match means the header carried proofs but none was the publisher's.
  // Reporting the first well-formed one is still better than nothing, and the
  // caller compares it against what it asked for.
  if (!publicKey && proofs.length > 0) {
    const candidate = proofs[0] ?? null
    if (candidate) {
      publicKey = candidate
      id = deriveExtensionId(candidate)
    }
  }

  return {
    version,
    headerLength,
    payloadOffset: CRX_PREFIX_BYTES + headerLength,
    publicKey,
    id,
    proofCount: proofs.length
  }
}

/**
 * Read the header of a CRX on disk without holding the payload in memory.
 *
 * A Web Store package can be 30 MB, and the only part the app needs before
 * unpacking is the first kilobyte, so the file is read in two bounded reads
 * rather than loaded whole.
 */
export async function readCrxHeader(
  filePath: string,
  expectedId: string | null
): Promise<CrxHeader> {
  const handle = await open(filePath, 'r')
  try {
    const prefix = Buffer.alloc(CRX_PREFIX_BYTES)
    const prefixRead = await handle.read(prefix, 0, CRX_PREFIX_BYTES, 0)
    if (prefixRead.bytesRead < CRX_PREFIX_BYTES)
      throw new Error('the file is too short to be a CRX')
    const headerLength = prefix.readUInt32LE(8)
    if (headerLength === 0 || headerLength > MAX_CRX_HEADER_BYTES) {
      throw new Error(`the CRX header length (${headerLength}) is not credible`)
    }
    const header = Buffer.alloc(headerLength)
    const headerRead = await handle.read(header, 0, headerLength, CRX_PREFIX_BYTES)
    return parseCrxHeader(prefix, header.subarray(0, headerRead.bytesRead), expectedId)
  } finally {
    await handle.close()
  }
}

/** A source folder's fingerprint: every file's path and content hash, except the
 *  directory Chromium writes generated rulesets into.
 *
 *  `_metadata/` is not the extension's source: enabling a static ruleset makes
 *  Chromium compile and write the indexed rulesets there, 10 MB of it for an
 *  ad blocker's lists. Hashing it would make the fingerprint change every time a
 *  ruleset was enabled, and the fingerprint exists to notice that the extension
 *  itself changed. */
export function hashExtensionSource(
  files: readonly { relativePath: string; contents: Buffer }[]
): string {
  const digest = createHash('sha256')
  const sorted = [...files]
    .filter((file) => !file.relativePath.split('/').includes('_metadata'))
    .sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1))
  for (const file of sorted) {
    digest.update(file.relativePath)
    digest.update('\0')
    digest.update(createHash('sha256').update(file.contents).digest())
    digest.update('\n')
  }
  return digest.digest('hex')
}
