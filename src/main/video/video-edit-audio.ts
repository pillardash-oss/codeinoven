import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWrite } from '../../lib/utils'
import type { VideoEditClip, VideoEditDocument } from '../../lib/video/edit'
import { videoFile } from './video-paths'
import { videoProcess } from './video-process'
import type { VideoJobContext } from './video-jobs'

export function audibleVideoEditClips(edit: VideoEditDocument): VideoEditClip[] {
  const tracks = new Map(edit.tracks.map((track) => [track.id, track]))
  const assets = new Map(edit.assets.map((asset) => [asset.id, asset]))
  return edit.clips.filter((clip) => {
    const track = tracks.get(clip.trackId)
    return (
      clip.volume > 0 &&
      !track?.muted &&
      (track?.volume ?? 1) > 0 &&
      (assets.get(clip.assetId)?.hasAudio ?? false)
    )
  })
}

/** Small time windows bound both decoder count and delay-line memory. */
export async function renderVideoEditAudio(
  folder: string,
  directory: string,
  edit: VideoEditDocument,
  context: VideoJobContext
): Promise<{ file: string; cleanup(): Promise<void> } | null> {
  const audible = audibleVideoEditClips(edit)
  if (!audible.length) return null
  const scratch = join(directory, `audio-${randomUUID()}`)
  await mkdir(scratch, { recursive: true })
  const cleanup = (): Promise<void> => rm(scratch, { recursive: true, force: true })
  try {
    const files = new Map<string, string>()
    for (const asset of edit.assets)
      if (audible.some((clip) => clip.assetId === asset.id))
        files.set(asset.id, await videoFile(folder, asset.source))
    const windows: { at: number; duration: number; warmup: number }[] = []
    const addWindow = (at: number, duration: number): void => {
      const active = audible.filter(
        (clip) => clip.start < at + duration && clip.start + clip.duration > Math.max(0, at - 0.15)
      )
      if (active.length <= 16) {
        windows.push({ at, duration, warmup: Math.min(at, 0.15) })
        return
      }
      if (duration < 0.04) {
        const current = audible.filter(
          (clip) => clip.start < at + duration && clip.start + clip.duration > at
        )
        if (current.length <= 16) {
          windows.push({ at, duration, warmup: 0 })
          return
        }
        throw new Error('Too many simultaneous audio clips; mute or combine a track before export')
      }
      addWindow(at, duration / 2)
      addWindow(at + duration / 2, duration / 2)
    }
    for (let at = 0; at < edit.duration; at += 30) addWindow(at, Math.min(30, edit.duration - at))
    const chunks: string[] = [],
      count = windows.length
    for (let index = 0; index < count; index += 1) {
      context.signal.throwIfAborted()
      const { at, duration, warmup } = windows[index]
      // Warm EQ and dynamics before a chunk boundary, then discard the warm-up.
      const begin = at - warmup,
        warm = at - begin,
        length = duration + warm
      const clips = audible.filter(
        (clip) => clip.start < at + duration && clip.start + clip.duration > begin
      )
      if (clips.length > 16)
        throw new Error('At most sixteen audio clips may overlap in one 30-second render window')
      const filename = `part-${String(index).padStart(4, '0')}.flac`,
        output = join(scratch, filename)
      chunks.push(filename)
      if (!clips.length) {
        await videoProcess(
          [
            '-f',
            'lavfi',
            '-i',
            'anullsrc=r=48000:cl=stereo',
            '-t',
            String(duration),
            '-c:a',
            'flac',
            '-y',
            output
          ],
          folder,
          context.signal
        )
      } else {
        const args: string[] = [],
          filters: string[] = []
        for (const [input, clip] of clips.entries()) {
          const from = Math.max(begin, clip.start),
            to = Math.min(at + duration, clip.start + clip.duration)
          const sourceStart = clip.sourceStart + (from - clip.start) * clip.speed
          args.push(
            '-ss',
            String(sourceStart),
            '-t',
            String((to - from) * clip.speed + 0.1),
            '-i',
            files.get(clip.assetId)!
          )
          const chain = [
            'aformat=sample_rates=48000:channel_layouts=stereo',
            `atrim=duration=${(to - from) * clip.speed}`,
            'asetpts=PTS-STARTPTS'
          ]
          let speed = clip.speed
          while (speed > 2) {
            chain.push('atempo=2')
            speed /= 2
          }
          while (speed < 0.5) {
            chain.push('atempo=0.5')
            speed /= 0.5
          }
          if (speed !== 1) chain.push(`atempo=${speed}`)
          if (clip.audio.highpass > 20) chain.push(`highpass=f=${clip.audio.highpass}`)
          if (clip.audio.lowpass < 20000) chain.push(`lowpass=f=${clip.audio.lowpass}`)
          if (clip.audio.deess > 0) chain.push(`deesser=i=${clip.audio.deess}:m=0.5:f=0.5`)
          if (clip.audio.compression > 0)
            chain.push(
              `acompressor=threshold=0.0631:ratio=${1 + clip.audio.compression * 7}:attack=5:release=100:makeup=${1 + clip.audio.compression}`
            )
          if (clip.audio.pan !== 0) chain.push(`stereotools=balance_out=${clip.audio.pan}`)
          const local = from - clip.start
          const fadeIn = clip.fadeIn ? `min(1,max(0,(t+${local})/${clip.fadeIn}))` : '1'
          const fadeOut = clip.fadeOut
            ? `min(1,max(0,(${clip.duration - local}-t)/${clip.fadeOut}))`
            : '1'
          // The track fader scales every clip on it, so raising speech or pulling
          // music down is one number rather than a pass over each segment.
          const trackGain = edit.tracks.find((track) => track.id === clip.trackId)?.volume ?? 1
          chain.push(
            `volume='${clip.volume * trackGain}*${fadeIn}*${fadeOut}':eval=frame`,
            `adelay=${Math.round((from - begin) * 1000)}:all=1`
          )
          filters.push(`[${input}:a]${chain.join(',')}[a${input}]`)
        }
        filters.push(
          `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,alimiter=limit=0.95:level=0,apad=whole_dur=${length},atrim=start=${warm}:duration=${duration},asetpts=PTS-STARTPTS[out]`
        )
        args.push(
          '-filter_complex',
          filters.join(';'),
          '-map',
          '[out]',
          '-ar',
          '48000',
          '-c:a',
          'flac',
          '-y',
          output
        )
        await videoProcess(args, folder, context.signal)
      }
      context.update(0.02 + (0.1 * (index + 1)) / count, `Mixing audio ${index + 1} of ${count}`)
    }
    const list = join(scratch, 'parts.txt'),
      file = join(scratch, 'mix.flac')
    await atomicWrite(list, chunks.map((name) => `file '${name}'`).join('\n'))
    await videoProcess(
      ['-f', 'concat', '-safe', '1', '-i', list, '-c:a', 'copy', '-y', file],
      folder,
      context.signal
    )
    return { file, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
