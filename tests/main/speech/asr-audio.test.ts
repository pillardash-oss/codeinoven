import { describe, expect, it } from 'vitest'
import {
  ASR_CHUNK_SECONDS,
  ASR_SAMPLE_RATE,
  TTS_MAX_TEXT_CHARACTERS,
  parseWavDataRegion,
  pcmChunkToSamples,
  splitTtsText
} from '../../../src/main/speech/asr-audio'

/** Builds a minimal RIFF/WAVE buffer with an arbitrary ordered chunk list. */
function buildWav(chunks: Array<{ id: string; payload: Buffer }>): Buffer {
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'latin1')
  header.write('WAVE', 8, 'latin1')
  const body = Buffer.concat(
    chunks.flatMap(({ id, payload }) => {
      const chunkHeader = Buffer.alloc(8)
      chunkHeader.write(id, 0, 'latin1')
      chunkHeader.writeUInt32LE(payload.length, 4)
      // RIFF chunks are word-aligned; odd sizes carry a pad byte.
      const pad = payload.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)
      return [chunkHeader, payload, pad]
    })
  )
  const riffSize = 4 + body.length
  header.writeUInt32LE(riffSize, 4)
  return Buffer.concat([header, body])
}

describe('parseWavDataRegion', () => {
  it('finds the data chunk and clamps its length to the real file size', () => {
    const pcm = Buffer.alloc(100)
    const wav = buildWav([
      { id: 'fmt ', payload: Buffer.alloc(16) },
      { id: 'LIST', payload: Buffer.from('INFOsome metadata') },
      { id: 'data', payload: pcm }
    ])
    const region = parseWavDataRegion(wav, wav.length)
    expect(region.dataOffset).toBe(wav.length - pcm.length)
    expect(region.dataLength).toBe(pcm.length)
  })

  it('handles an odd-sized chunk before data (word padding)', () => {
    const pcm = Buffer.alloc(10)
    const wav = buildWav([
      { id: 'ODD ', payload: Buffer.from('abcde') },
      { id: 'data', payload: pcm }
    ])
    const region = parseWavDataRegion(wav, wav.length)
    expect(region.dataOffset).toBe(wav.length - pcm.length)
    expect(region.dataLength).toBe(pcm.length)
  })

  it('clamps an oversized declared data size to the actual file size', () => {
    const pcm = Buffer.alloc(10)
    const wav = buildWav([{ id: 'data', payload: pcm }])
    // Declare 1000 bytes of data in a 30-byte file (truncated stream).
    wav.writeUInt32LE(1000, wav.length - 10 - 4)
    const region = parseWavDataRegion(wav, wav.length)
    expect(region.dataLength).toBe(10)
  })

  it('rejects non-WAV input', () => {
    const notWav = Buffer.from('not a wave file at all')
    expect(() => parseWavDataRegion(notWav, notWav.length)).toThrow(
      'The decoded recording is not a valid WAV file.'
    )
  })

  it('rejects a WAV with no data chunk', () => {
    const wav = buildWav([{ id: 'fmt ', payload: Buffer.alloc(16) }])
    expect(() => parseWavDataRegion(wav, wav.length)).toThrow(
      'The decoded recording has no PCM data chunk.'
    )
  })
})

describe('pcmChunkToSamples', () => {
  it('converts 16-bit LE PCM into [-1, 1) floats', () => {
    const buffer = Buffer.alloc(6)
    buffer.writeInt16LE(-32768, 0)
    buffer.writeInt16LE(0, 2)
    buffer.writeInt16LE(32767, 4)
    const samples = pcmChunkToSamples(buffer, 6)
    expect(samples).toEqual(Float32Array.from([-1, 0, 32767 / 32768]))
  })

  it('ignores a trailing partial frame', () => {
    const buffer = Buffer.alloc(5)
    buffer.writeInt16LE(16384, 0)
    const samples = pcmChunkToSamples(buffer, 5)
    expect(samples.length).toBe(2)
    expect(samples[1]).toBe(0)
  })
})

describe('splitTtsText', () => {
  it('passes short text through as a single piece', () => {
    expect(splitTtsText('Hello world')).toEqual(['Hello world'])
  })

  it('returns no pieces for blank text', () => {
    expect(splitTtsText('   ')).toEqual([])
  })

  it('splits oversized text on word boundaries without cutting words', () => {
    const words = Array.from({ length: 300 }, (_, index) => `w${index}`)
    const text = words.join(' ')
    expect(text.length).toBeGreaterThan(TTS_MAX_TEXT_CHARACTERS)
    const pieces = splitTtsText(text)
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(TTS_MAX_TEXT_CHARACTERS)
    }
    // Word boundaries respected: every piece contains only whole words.
    for (const piece of pieces) {
      for (const word of piece.split(' ')) expect(words).toContain(word)
    }
    expect(pieces.join(' ').split(/\s+/u)).toEqual(words)
  })

  it('hard-splits a single word longer than the budget', () => {
    const longWord = 'a'.repeat(TTS_MAX_TEXT_CHARACTERS + 100)
    const pieces = splitTtsText(longWord)
    expect(pieces.length).toBe(2)
    expect(pieces[0].length).toBe(TTS_MAX_TEXT_CHARACTERS)
    expect(pieces[1].length).toBe(100)
    expect(pieces.join('')).toBe(longWord)
  })

  it('never lets a boundary fall between surrogate pairs of a chunked word', () => {
    // 30s of audio at 16kHz mono 16-bit is the ASR window; unrelated but the
    // chunk math is the same byte-budget idea.
    expect(ASR_CHUNK_SECONDS * ASR_SAMPLE_RATE).toBe(480_000)
    const longWord = '🙂'.repeat(300)
    const pieces = splitTtsText(longWord)
    for (const piece of pieces) {
      // Every code point survives intact — no lone surrogates.
      expect(Array.from(piece).every((char) => char === '🙂')).toBe(true)
    }
  })
})
