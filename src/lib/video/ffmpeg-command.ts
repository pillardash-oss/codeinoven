import {
  videoClipPlacements,
  videoReelDuration,
  type VideoClip,
  type VideoComposition,
  type VideoTextLayer
} from './composition'

/**
 * Compile a composition into one ffmpeg invocation.
 *
 * Pure on purpose: the same document always produces the same argument list, so
 * the command can be written to a log, checked in a verification script, and
 * reasoned about without a process. The caller resolves paths and supplies a
 * font, which are the only two things this module cannot know.
 *
 * The graph is built in three passes and joined with `filter_complex`:
 *
 * 1. every clip is normalized to the output size, frame rate and pixel format,
 *    which is what lets `xfade` join two clips from different cameras;
 * 2. the clips are chained with `xfade`, using each clip's own timeline start as
 *    the overlap offset;
 * 3. text is drawn over the finished picture, with `enable` bounding each layer
 *    to its own window.
 *
 * Sound is a fourth pass: each source's own audio and every music track is
 * delayed to its place on the timeline and mixed together afterwards.
 */

/**
 * How much of the reel a render covers. A draft previews, a final export ships.
 */
export type VideoRenderQuality = 'draft' | 'final'

/**
 * Longest side of a draft render.
 *
 * A draft is watched in a side panel while it is still changing, so it is
 * rendered smaller than the deliverable. Size is the one lever that measurably
 * matters here: the same 7s reel took about 11.8s at 1280x720 and about 4.1s at
 * 640x360 on this machine. Preset differences were inside the run-to-run noise,
 * which is why the draft preset is left at ultrafast and nothing is tuned
 * against a single measurement.
 */
export const DEFAULT_DRAFT_LONG_SIDE = 960

/** Container for the encoded result. WebM is what a browser always plays. */
export type VideoRenderContainer = 'mp4' | 'webm'

/**
 * One resolved source, as the graph needs to see it.
 *
 * Whether a file carries sound has to be known before the graph is written. A
 * stream specifier that names a track the file does not have is an ffmpeg error
 * rather than an empty stream, so a silent clip would break a render that is
 * otherwise correct. The caller probes each source once and answers here.
 */
export interface VideoRenderSource {
  /** What ffmpeg opens: an absolute path, or the URL unchanged. */
  path: string
  /** Whether the file carries a sound stream. An image never does. */
  hasAudio: boolean
}

export interface VideoRenderRequest {
  /** Absolute path of the ffmpeg binary, from the app's own resolver. */
  ffmpegPath: string
  composition: VideoComposition
  /**
   * Turn one document source into something ffmpeg can open, with what the
   * graph needs to know about it. The caller owns this so the folder guard and
   * the probing stay in one place.
   */
  resolveSource: (source: string) => VideoRenderSource
  /** Font file every text layer is drawn with. */
  fontFile: string
  /** Absolute path the encoded file is written to. */
  outputPath: string
  quality: VideoRenderQuality
  container: VideoRenderContainer
  /**
   * Let the platform encoder do the work. Worth asking for on a full-size final
   * render, and worse than software on a small draft: measured 7.6s against
   * 3.4s for the same 30s draft on this machine.
   */
  hardware?: boolean
  /** Longest side of a draft render. Defaults to `DEFAULT_DRAFT_LONG_SIDE`. */
  draftLongSide?: number
}

/** The frame a render actually writes, which a draft may shrink. */
export interface VideoRenderFrame {
  width: number
  height: number
  /** What the draft scale did, so absolute sizes in the document scale with it. */
  scale: number
}

function evenDimension(value: number): number {
  const rounded = Math.round(value)
  return rounded % 2 === 0 ? rounded : rounded + 1
}

/**
 * The frame a render writes.
 *
 * A draft keeps the composition's shape and scales it down, and reports the
 * factor so a text size written against the full frame keeps its proportion.
 * Without that, text would be relatively larger in every draft than in the
 * export and the preview would misrepresent the cut.
 */
export function videoRenderFrame(
  composition: VideoComposition,
  quality: VideoRenderQuality,
  draftLongSide = DEFAULT_DRAFT_LONG_SIDE
): VideoRenderFrame {
  if (quality === 'final') {
    return { width: composition.width, height: composition.height, scale: 1 }
  }
  const longest = Math.max(composition.width, composition.height)
  if (longest <= draftLongSide) {
    return { width: composition.width, height: composition.height, scale: 1 }
  }
  const scale = draftLongSide / longest
  return {
    width: evenDimension(composition.width * scale),
    height: evenDimension(composition.height * scale),
    scale
  }
}

/** `#rrggbb` as ffmpeg spells it. */
function ffmpegColour(hex: string): string {
  return `0x${hex.slice(1).toLowerCase()}`
}

/**
 * Escape one text layer for `drawtext`.
 *
 * The text lands inside a filter graph, so the characters that build the graph
 * have to survive: a colon separates options, a comma separates filters, and a
 * bracket can read as a stream label. Single quotes and percent signs are
 * drawtext's own, and a newline is its escape for a line break.
 */
export function escapeDrawtextValue(text: string): string {
  return text
    .replace(/\\/gu, '\\\\')
    .replace(/'/gu, "\\'")
    .replace(/:/gu, '\\:')
    .replace(/%/gu, '\\%')
    .replace(/,/gu, '\\,')
    .replace(/;/gu, '\\;')
    .replace(/\[/gu, '\\[')
    .replace(/\]/gu, '\\]')
    .replace(/\n/gu, '\\n')
}

/**
 * How long a clip's own sound runs before the input is closed.
 *
 * Bounding the input matters for sound: an unbounded music file would be
 * decoded from end to end for a thirty second reel.
 */
function audioInputBound(seconds: number): string {
  return seconds.toFixed(3)
}

function clipNormalization(
  clip: VideoClip,
  composition: VideoComposition,
  frame: VideoRenderFrame
): string {
  const fit = clip.fit ?? 'cover'
  const width = frame.width
  const height = frame.height
  const fill = ffmpegColour(clip.fill ?? composition.background)
  const scaled =
    fit === 'cover'
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${fill}`
  return `${scaled},setsar=1,fps=${composition.fps},format=yuv420p`
}

/** One text layer as a `drawtext` filter, bounded to its own window. */
function textFilter(layer: VideoTextLayer, fontFile: string, frame: VideoRenderFrame): string {
  // A text size is written against the composition's own height, so a shrunken
  // draft scales it by the same factor and the preview keeps its proportions.
  const fontSize = Math.max(6, Math.round((layer.fontSize ?? 48) * frame.scale))
  const colour = ffmpegColour(layer.color ?? '#ffffff')
  const { x: px, y: py } = layer.position ?? { x: 0.5, y: 0.85 }
  const escapeFont = fontFile.replace(/\\/gu, '\\\\').replace(/:/gu, '\\:').replace(/'/gu, "\\'")
  const parts = [
    `fontfile='${escapeFont}'`,
    // The text is escaped rather than quoted. A single quote inside a quoted value
    // ends the quote region, and everything after it is then read as filter graph
    // syntax, so a caption containing an apostrophe would break the whole render.
    // Escaping every graph character instead keeps any text legal.
    `text=${escapeDrawtextValue(layer.text)}`,
    // Text is literal: no %{...} expansion, so a percent sign means a percent sign.
    'expansion=none',
    `fontcolor=${colour}`,
    `fontsize=${fontSize}`,
    `x=(w-text_w)*${px.toFixed(4)}`,
    `y=(h-text_h)*${py.toFixed(4)}`
  ]
  if (layer.background) {
    const backgroundColour = ffmpegColour(layer.background.color)
    const opacity = layer.background.opacity ?? 0.6
    parts.push('box=1', `boxcolor=${backgroundColour}@${opacity.toFixed(2)}`)
    parts.push(`boxborderw=${Math.round(layer.background.padding ?? 18)}`)
  }
  if (layer.fade && layer.fade > 0) {
    const fade = layer.fade
    parts.push(
      `alpha='if(lt(t,${layer.start}+${fade}),(t-${layer.start})/${fade},if(gt(t,${layer.end}-${fade}),(${layer.end}-t)/${fade},1))'`
    )
  }
  parts.push(`enable='between(t,${layer.start},${layer.end})'`)
  return `drawtext=${parts.join(':')}`
}

/**
 * Build the argument list for one render.
 *
 * The result is meant to be handed to `spawn` as it is, without a shell: the
 * first element is the binary and no argument is quoted for a shell, so a source
 * path never has to be trusted as shell input.
 */
export function buildVideoRenderCommand(request: VideoRenderRequest): string[] {
  const { composition, quality, container } = request
  const placements = videoClipPlacements(composition)
  const reel = videoReelDuration(composition)
  const frame = videoRenderFrame(composition, quality, request.draftLongSide)
  const args: string[] = [request.ffmpegPath, '-y', '-hide_banner', '-nostdin']

  // Each source is resolved once, before the argument list is written, because
  // whether a file carries sound decides which filters exist at all.
  const clipSources: VideoRenderSource[] = composition.clips.map((clip) =>
    request.resolveSource(clip.source)
  )
  let clipIndex = 0

  // Pass 1: one input per clip, trimmed at the input so nothing is decoded that
  // the reel does not show.
  for (const clip of composition.clips) {
    const source = clipSources[clipIndex]!.path
    clipIndex += 1
    if (clip.kind === 'image') {
      args.push(
        '-loop',
        '1',
        '-framerate',
        String(composition.fps),
        '-t',
        audioInputBound(clip.duration)
      )
    } else if (clip.sourceIn && clip.sourceIn > 0) {
      args.push('-ss', audioInputBound(clip.sourceIn))
    }
    if (clip.kind === 'video') {
      args.push('-t', audioInputBound(clip.duration))
    }
    args.push('-i', source)
  }

  // Pass 1b: every sound source, each bounded to what fits on the timeline.
  const audioTracks = composition.audio
  const audioTrackSources = audioTracks.map((track) => request.resolveSource(track.source))
  for (const [offset, track] of audioTracks.entries()) {
    const start = track.start ?? 0
    const bound = track.duration ?? Math.max(0.05, reel - start)
    if (track.sourceIn && track.sourceIn > 0) args.push('-ss', audioInputBound(track.sourceIn))
    args.push('-t', audioInputBound(bound), '-i', audioTrackSources[offset]!.path)
  }

  const hasAnyAudio =
    audioTracks.length > 0 ||
    composition.clips.some(
      (clip, index) =>
        clip.kind === 'video' && clip.audio !== false && clipSources[index]!.hasAudio === true
    )
  let silenceInputIndex = -1
  if (!hasAnyAudio) {
    silenceInputIndex = composition.clips.length + audioTracks.length
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
  }

  // Pass 2: normalize every picture, then chain the clips with xfade.
  const filters: string[] = []
  for (const [index, placement] of placements.entries()) {
    filters.push(`[${index}:v]${clipNormalization(placement.clip, composition, frame)}[c${index}]`)
  }
  let pictureLabel = 'c0'
  for (const [index, placement] of placements.entries()) {
    if (index === 0) continue
    const transition = placement.clip.transition
    const type = transition?.type ?? 'fade'
    const overlap = placement.overlap
    const next = `x${index}`
    filters.push(
      `[${pictureLabel}][c${index}]xfade=transition=${type}:duration=${overlap.toFixed(3)}:offset=${placement.start.toFixed(3)}[${next}]`
    )
    pictureLabel = next
  }

  // Pass 3: text over the finished picture.
  let overlayIndex = 0
  for (const layer of composition.text) {
    const next = `t${overlayIndex}`
    filters.push(`[${pictureLabel}]${textFilter(layer, request.fontFile, frame)}[${next}]`)
    pictureLabel = next
    overlayIndex += 1
  }
  filters.push(`[${pictureLabel}]format=yuv420p[vout]`)

  // Pass 4: place every sound source and mix them.
  const soundLabels: string[] = []
  for (const [index, placement] of placements.entries()) {
    const clip = placement.clip
    if (clip.kind !== 'video' || clip.audio === false) continue
    if (clipSources[index]!.hasAudio !== true) continue
    const label = `a${index}`
    const chain = [`aresample=48000`, `aformat=sample_fmts=fltp:channel_layouts=stereo`]
    if (clip.volume !== undefined && clip.volume !== 1) {
      chain.unshift(`volume=${clip.volume.toFixed(3)}`)
    }
    const delayMs = Math.round(placement.start * 1_000)
    if (delayMs > 0) chain.push(`adelay=${delayMs}:all=1`)
    filters.push(`[${index}:a]${chain.join(',')}[${label}]`)
    soundLabels.push(label)
  }
  for (const [offset, track] of audioTracks.entries()) {
    const inputIndex = composition.clips.length + offset
    const label = `m${offset}`
    const chain = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo']
    const start = track.start ?? 0
    const duration = track.duration ?? Math.max(0.05, reel - start)
    if (track.volume !== undefined && track.volume !== 1)
      chain.unshift(`volume=${track.volume.toFixed(3)}`)
    if (track.fadeIn && track.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${track.fadeIn.toFixed(3)}`)
    if (track.fadeOut && track.fadeOut > 0) {
      const from = Math.max(0, duration - track.fadeOut)
      chain.push(`afade=t=out:st=${from.toFixed(3)}:d=${track.fadeOut.toFixed(3)}`)
    }
    const delayMs = Math.round(start * 1_000)
    if (delayMs > 0) chain.push(`adelay=${delayMs}:all=1`)
    filters.push(`[${inputIndex}:a]${chain.join(',')}[${label}]`)
    soundLabels.push(label)
  }
  if (silenceInputIndex >= 0) {
    filters.push(
      `[${silenceInputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[asilence]`
    )
    filters.push(`[asilence]atrim=0:${reel.toFixed(3)},asetpts=N/SR/TB[aout]`)
  } else if (soundLabels.length === 1) {
    filters.push(`[${soundLabels[0]}]atrim=0:${reel.toFixed(3)},asetpts=N/SR/TB[aout]`)
  } else {
    const inputs = soundLabels.map((label) => `[${label}]`).join('')
    filters.push(`${inputs}amix=inputs=${soundLabels.length}:duration=longest:normalize=0[amixed]`)
    filters.push(`[amixed]atrim=0:${reel.toFixed(3)},asetpts=N/SR/TB[aout]`)
  }

  args.push('-filter_complex', filters.join(';'))
  args.push('-map', '[vout]', '-map', '[aout]')

  // A draft previews the cut, so it is fast and small. A final export is the
  // deliverable, so it is slow and faithful.
  if (quality === 'draft' && container === 'webm') {
    args.push(
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-b:v',
      '0',
      '-crf',
      '40',
      '-c:a',
      'libopus',
      '-b:a',
      '96k'
    )
  } else if (quality === 'draft') {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k'
    )
  } else if (request.hardware) {
    args.push(
      '-c:v',
      'h264_videotoolbox',
      '-b:v',
      '12M',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k'
    )
  } else {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-c:a',
      'aac',
      '-b:a',
      '192k'
    )
  }
  args.push('-t', reel.toFixed(3))
  args.push(request.outputPath)
  return args
}

/** The reel length a render will produce, which a reply can name up front. */
export function videoRenderDuration(composition: VideoComposition): number {
  return videoReelDuration(composition)
}
