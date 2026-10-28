import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  newVideoEditClip,
  validateVideoEdit,
  type VideoEditAsset,
  type VideoEditDocument
} from '../../lib/video/edit'
import type { VideoStudioDocument } from '../../lib/video/studio'
import type { VideoProjectManifest } from '../../lib/video/project'
import { videoFile } from './video-paths'
import { probeVideo } from './video-inspection'

/** Convert retained source decisions, not the exported movie, into editable clips. */
export async function migrateVideoEdit(
  folder: string,
  studio: VideoStudioDocument,
  manifest: VideoProjectManifest,
  signal: AbortSignal
): Promise<VideoEditDocument> {
  if (studio.edit) return studio.edit
  const htmlFile = await videoFile(folder, 'index.html')
  if ((await stat(htmlFile)).size > 512_000)
    throw new Error('The composition page is too large to convert automatically')
  const html = await readFile(htmlFile, 'utf8')
  const source = /<video\b[^>]*\bsrc=["']([^"']+)["']/iu.exec(html)?.[1]
  const edit: VideoEditDocument = {
    version: 1,
    background: source ? 'black' : 'composition',
    duration: manifest.duration,
    assets: [],
    tracks: [
      { id: 'picture', name: 'Video', kind: 'video', locked: false, muted: false, hidden: false },
      {
        id: 'dialogue',
        name: 'Dialogue',
        kind: 'audio',
        locked: false,
        muted: false,
        hidden: false
      },
      {
        id: 'overlays',
        name: 'Overlays',
        kind: 'overlay',
        locked: false,
        muted: false,
        hidden: false
      },
      {
        id: 'music',
        name: 'Music / effects',
        kind: 'audio',
        locked: false,
        muted: false,
        hidden: false
      }
    ],
    clips: [],
    regions: [],
    changes: []
  }
  const assetBySource = new Map<string, VideoEditAsset>()
  async function asset(source: string, kind: 'video' | 'audio'): Promise<VideoEditAsset> {
    const existing = assetBySource.get(source)
    if (existing) return existing
    const info = await probeVideo(folder, source, signal)
    const result: VideoEditAsset = {
      id: crypto.randomUUID(),
      name: basename(source),
      source,
      kind,
      duration: info.duration ?? manifest.duration,
      width: info.width ?? 0,
      height: info.height ?? 0,
      hasAudio: info.hasAudio
    }
    edit.assets.push(result)
    assetBySource.set(source, result)
    return result
  }
  if (source) {
    const picture = await asset(source, 'video')
    let decisions: unknown[] | null = null
    for (const file of ['edit-decision-list.json', 'edit-map.json']) {
      const path = await videoFile(folder, file).catch(() => null)
      if (!path) continue
      if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error('The cut map is too large')
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (typeof raw !== 'object' || raw === null) throw new Error('Invalid cut map')
      const map = raw as Record<string, unknown>
      const entries = map.clips ?? map.segments
      if (!Array.isArray(entries) || entries.length > 4000)
        throw new Error('Invalid cut map entries')
      decisions = entries
      break
    }
    if (decisions)
      for (const raw of decisions) {
        if (typeof raw !== 'object' || raw === null) throw new Error('Invalid cut decision')
        const decision = raw as Record<string, unknown>
        const clip = newVideoEditClip(
          picture,
          'picture',
          Number(decision.start),
          Number(decision.duration)
        )
        clip.sourceStart = Number(decision.sourceStart ?? 0)
        clip.volume = 0 // The retained dialogue mix below already contains this sound.
        edit.clips.push(clip)
      }
    else {
      const clip = newVideoEditClip(
        picture,
        'picture',
        0,
        Math.min(manifest.duration, picture.duration)
      )
      clip.volume = manifest.audio.length || studio.audioTracks.length ? 0 : 1
      edit.clips.push(clip)
    }
    const crop =
      /drawImage\(\s*video\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,/u.exec(
        html
      )
    if (crop && picture.width && picture.height)
      for (const clip of edit.clips)
        clip.crop = {
          x: Number(crop[1]) / picture.width,
          y: Number(crop[2]) / picture.height,
          width: Number(crop[3]) / picture.width,
          height: Number(crop[4]) / picture.height
        }
    // Preserve the known source-timed privacy cover in existing tutorial pages.
    // A conversion must never uncover a key because its mask lived in code.
    const masks = html.matchAll(
      /if\s*\(\s*target\s*>=\s*([\d.]+)\s*&&\s*target\s*<\s*([\d.]+)\s*\)/gu
    )
    for (const mask of masks)
      for (const clip of edit.clips) {
        const from = Math.max(Number(mask[1]), clip.sourceStart)
        const to = Math.min(Number(mask[2]), clip.sourceStart + clip.duration)
        if (to > from)
          edit.regions.push({
            id: crypto.randomUUID(),
            start: clip.start + from - clip.sourceStart,
            duration: to - from,
            kind: 'cover',
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            amount: 100,
            color: '#000000'
          })
      }
  }
  const tracks = studio.audioTracks.length
    ? studio.audioTracks
    : manifest.audio.map((source) => ({
        source,
        start: 0,
        trim: 0,
        duration: manifest.duration,
        gain: 1
      }))
  for (const track of tracks) {
    const audio = await asset(track.source, 'audio')
    const clip = newVideoEditClip(
      audio,
      'dialogue',
      track.start,
      Math.min(track.duration, Math.max(0.001, audio.duration - track.trim))
    )
    clip.sourceStart = track.trim
    clip.volume = track.gain
    edit.clips.push(clip)
  }
  edit.tracks.sort((a, b) => (a.kind === 'overlay' ? -1 : b.kind === 'overlay' ? 1 : 0))
  return validateVideoEdit(edit)
}
