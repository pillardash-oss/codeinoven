import { join, relative } from 'node:path'
import { rm } from 'node:fs/promises'
import { atomicWrite } from '../../lib/utils'
import { videoNumber, type VideoCaption } from '../../lib/video/studio'
import { videoFile, videoOutput, videoScratch } from './video-paths'
import { videoProcess } from './video-process'
import type { VideoJobContext } from './video-jobs'
import type { SpeechService } from '../speech/speech-service'

export interface VideoMediaInfo {
  duration: number | null
  width: number | null
  height: number | null
  fps: number | null
  hasAudio: boolean
  streams: string[]
}
export async function probeVideo(
  root: string,
  source: string,
  signal: AbortSignal
): Promise<VideoMediaInfo> {
  const file = await videoFile(root, source)
  const report = await videoProcess(
    ['-i', file, '-t', '0.001', '-map', '0:v:0?', '-map', '0:a:0?', '-f', 'null', '-'],
    root,
    signal
  )
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/u.exec(report)
  const video = report.split('\n').find((line) => /Stream.*Video:/u.test(line))
  const size = video ? /\b(\d{2,5})x(\d{2,5})\b/u.exec(video) : null
  const fps = video ? /([\d.]+) fps/u.exec(video) : null
  return {
    duration: duration
      ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
      : null,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    fps: fps ? Number(fps[1]) : null,
    hasAudio: /Stream.*Audio:/u.test(report),
    streams: report
      .split('\n')
      .filter((line) => /Stream #0:/u.test(line))
      .slice(0, 24)
  }
}
export async function inspectVideo(
  operation: string,
  root: string,
  input: Record<string, unknown>,
  context: VideoJobContext,
  speech: SpeechService | null,
  artifactId?: string
): Promise<{ files: string[]; result?: unknown }> {
  const source = await videoFile(root, input.source)
  const directory = await videoOutput(root, 'inspection')
  const start = videoNumber(input.start ?? 0, 'start', 0, 3600)
  const duration = videoNumber(input.duration ?? 10, 'duration', 0.1, 600)
  const files: string[] = []
  const info = await probeVideo(root, relative(root, source), context.signal)
  if (info.duration !== null && start >= info.duration)
    throw new Error('Start is past the end of the source')
  const length = info.duration === null ? duration : Math.min(duration, info.duration - start)
  context.update(0.1, 'Reading footage')
  if (operation === 'filmstrip') {
    if (!info.width) throw new Error('The source has no video stream')
    const count = Math.round(videoNumber(input.count ?? 8, 'count', 1, 24))
    for (let index = 0; index < count; index += 1) {
      const time = start + (length * index) / count
      const output = join(directory, `frame-${index + 1}.jpg`)
      await videoProcess(
        ['-ss', String(time), '-i', source, '-frames:v', '1', '-vf', 'scale=480:-2', '-y', output],
        root,
        context.signal
      )
      files.push(relative(root, output).replaceAll('\\', '/'))
      context.update((index + 1) / count, `Frame ${index + 1} of ${count}`)
    }
    return {
      files,
      result: {
        start,
        duration: length,
        times: Array.from({ length: count }, (_, index) => start + (length * index) / count)
      }
    }
  }
  if (!info.hasAudio) throw new Error('The source has no audio stream')
  if (operation === 'waveform' || operation === 'listen') {
    const output = join(directory, operation === 'waveform' ? 'waveform.png' : 'listen.wav')
    const args = ['-ss', String(start), '-t', String(length), '-i', source]
    if (operation === 'waveform')
      args.push(
        '-filter_complex',
        'aresample=8000,aformat=channel_layouts=mono,showwavespic=s=1200x240',
        '-frames:v',
        '1'
      )
    else args.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le')
    await videoProcess([...args, '-y', output], root, context.signal)
    return {
      files: [relative(root, output).replaceAll('\\', '/')],
      result: { start, duration: length }
    }
  }
  if (operation !== 'transcribe') throw new Error('Unsupported footage operation')
  if (!speech || !artifactId)
    throw new Error('Select an installed transcription model in Sounds first')
  const captions: VideoCaption[] = []
  let wordTimed = true
  // Existing ASR returns text, not word alignment. Keep measured chunk boundaries explicit.
  const chunkSeconds = videoNumber(input.chunkSeconds ?? 4, 'chunkSeconds', 2, 30)
  const language =
    typeof input.language === 'string' && input.language.length <= 32 ? input.language : 'auto'
  const scratch = await videoScratch(root, 'transcription')
  const chunkPath = join(scratch, 'chunk.wav')
  try {
    for (let offset = 0; offset < length; offset += chunkSeconds) {
      const chunkLength = Math.min(chunkSeconds, length - offset)
      await videoProcess(
        [
          '-ss',
          String(start + offset),
          '-t',
          String(chunkLength),
          '-i',
          source,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          '-y',
          chunkPath
        ],
        root,
        context.signal
      )
      const transcript = await speech.transcribeVideoChunk(
        chunkPath,
        artifactId,
        language,
        context.signal
      )
      if (transcript.text) {
        wordTimed = wordTimed && Boolean(transcript.words?.length)
        const words = transcript.words?.map((word) => ({
          ...word,
          start: start + offset + word.start,
          end: start + offset + word.end
        }))
        captions.push({
          text: transcript.text,
          start: start + offset,
          end: start + offset + chunkLength,
          ...(words ? { words } : {})
        })
      }
      context.update((offset + chunkLength) / length, 'Transcribing footage')
    }
    const output = join(directory, 'captions.json')
    const timing = wordTimed && captions.length ? 'word' : 'chunk'
    await atomicWrite(output, JSON.stringify({ timing, sourceStart: start, captions }, null, 2))
    return {
      files: [relative(root, output).replaceAll('\\', '/')],
      result: {
        captions,
        timing,
        note:
          timing === 'word'
            ? 'Word timing comes from the recognizer.'
            : 'This model supplied no complete word alignment; timing follows audio chunk boundaries.'
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
