/**
 * Pure audio-format and text-bounding helpers for the sherpa worker.
 *
 * Kept free of sherpa-onnx-node / worker_threads imports so the binary-parsing
 * and chunking logic stays unit-testable without loading the native addon.
 */

/**
 * Offline encoders allocate activation tensors proportional to input length
 * (attention memory grows quadratically for Parakeet/NeMo), so a long enough
 * recording asks the BFC arena for gigabytes and aborts the whole process.
 * Decoding bounded windows keeps the peak allocation small and predictable.
 */
export const ASR_CHUNK_SECONDS = 30
export const ASR_SAMPLE_RATE = 16_000
export const ASR_BYTES_PER_SAMPLE = 2

/** Defensive split so a normalizer regression can never hand kokoro a huge blob. */
export const TTS_MAX_TEXT_CHARACTERS = 480

export interface WavDataRegion {
  dataOffset: number
  dataLength: number
}

/** Walks RIFF chunk headers to find the PCM data region of a finished WAV file. */
export function parseWavDataRegion(header: Buffer, fileSize: number): WavDataRegion {
  const isRiff =
    header.length >= 12 &&
    header.toString('latin1', 0, 4) === 'RIFF' &&
    header.toString('latin1', 8, 12) === 'WAVE'
  if (!isRiff) throw new Error('The decoded recording is not a valid WAV file.')
  let offset = 12
  while (offset + 8 <= header.length) {
    const id = header.toString('latin1', offset, offset + 4)
    const size = header.readUInt32LE(offset + 4)
    if (id === 'data') {
      const dataOffset = offset + 8
      return { dataOffset, dataLength: Math.min(size, fileSize - dataOffset) }
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('The decoded recording has no PCM data chunk.')
}

/** Converts signed 16-bit little-endian PCM into the float range sherpa expects. */
export function pcmChunkToSamples(buffer: Buffer, byteLength: number): Float32Array {
  const frameCount = Math.floor(byteLength / ASR_BYTES_PER_SAMPLE)
  const samples = new Float32Array(frameCount)
  for (let index = 0; index < frameCount; index += 1) {
    samples[index] = buffer.readInt16LE(index * ASR_BYTES_PER_SAMPLE) / 32768
  }
  return samples
}

/** Splits oversized text on word boundaries so kokoro never sees a huge blob. */
export function splitTtsText(text: string): string[] {
  const trimmed = text.trim()
  if (trimmed.length <= TTS_MAX_TEXT_CHARACTERS) return trimmed ? [trimmed] : []
  const pieces: string[] = []
  let current = ''
  for (const word of trimmed.split(/\s+/u)) {
    if (word.length > TTS_MAX_TEXT_CHARACTERS) {
      if (current) {
        pieces.push(current)
        current = ''
      }
      for (let index = 0; index < word.length; index += TTS_MAX_TEXT_CHARACTERS) {
        pieces.push(word.slice(index, index + TTS_MAX_TEXT_CHARACTERS))
      }
      continue
    }
    if (current.length + 1 + word.length > TTS_MAX_TEXT_CHARACTERS) {
      pieces.push(current)
      current = ''
    }
    current = current ? `${current} ${word}` : word
  }
  if (current) pieces.push(current)
  return pieces
}
