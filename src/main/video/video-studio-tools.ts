import type { McpTool } from '../agents/mcp-stdio-client'

/** Explicit tool contracts keep agents from guessing footage or edit operations. */
export function videoStudioTools(): McpTool[] {
  const source = {
    type: 'string',
    description: 'Existing project-relative media file. Symlink escapes are refused.'
  }
  const directory = { type: 'string', description: 'Existing project-relative composition folder.' }
  const start = {
    type: 'number',
    minimum: 0,
    maximum: 3600,
    description: 'Source start in seconds.'
  }
  const duration = {
    type: 'number',
    minimum: 0.1,
    maximum: 600,
    description: 'Seconds to analyze, up to ten minutes per request.'
  }
  function tool(
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[] = []
  ): McpTool {
    return {
      name,
      description,
      inputSchema: { type: 'object', properties, required, additionalProperties: false }
    }
  }
  const jobNote =
    ' Returns a running job immediately. Poll jobs for progress, files and errors. One expensive video job runs at a time. The user can cancel in Video controls.'
  const tools: McpTool[] = [
    tool(
      'editor',
      'Open/read a source-preserving editable timeline, import local media into assets/, or apply up to 64 incremental commands at the saved revision. Read first. action:read enables legacy cut-map conversion with Undo history. action:apply requires revision and operations. Commands: addTrack{name,trackKind:video|audio|overlay}, addClip{assetId,trackId,start,duration?}, split{id,at}, trim{id,edge:start|end,at}, move{id,start,trackId?}, remove{id,ripple?}, patchClip{id,patch}, addRegion{region:{start,duration,x,y,width,height,kind:blur|pixelate|cover,amount,color}}, removeRegion{id}, review{id?}. Clips carry sourceStart, speed, volume, opacity, normalized rect/crop, grade{exposure,contrast,saturation,temperature,hue}, audio{highpass,lowpass,deess,compression,pan}, fadeIn/fadeOut, transition{kind:none|dissolve|fade|slide|zoom,duration}. Original assets are never deleted. Unreviewed agent saves are marked by changed time range. action:import accepts composition-relative sources and returns assets; use addClip to place them.',
      {
        directory,
        action: { type: 'string', enum: ['read', 'apply', 'import'] },
        revision: { type: 'string' },
        sources: { type: 'array', maxItems: 16, items: { type: 'string' } },
        operations: {
          type: 'array',
          maxItems: 64,
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: [
                  'addTrack',
                  'addClip',
                  'split',
                  'trim',
                  'move',
                  'remove',
                  'patchClip',
                  'addRegion',
                  'removeRegion',
                  'review'
                ]
              }
            },
            required: ['kind']
          }
        }
      },
      ['directory']
    ),
    tool(
      'probe',
      'Read source duration, frame size, frame rate and streams using the bundled decoder.',
      { source },
      ['source']
    ),
    tool(
      'filmstrip',
      'Extract up to 24 small JPEG frames at known source times. Open the returned images to inspect the footage.' +
        jobNote,
      { source, start, duration, count: { type: 'integer', minimum: 1, maximum: 24 } },
      ['source']
    ),
    tool(
      'waveform',
      'Create a bounded waveform PNG for a source audio range.' + jobNote,
      { source, start, duration },
      ['source']
    ),
    tool(
      'listen',
      'Extract a mono WAV excerpt for listening or further analysis.' + jobNote,
      { source, start, duration },
      ['source']
    ),
    tool(
      'transcribe',
      'Transcribe footage with the installed ASR selected in Sounds. Caption timing uses measured audio chunks, not inferred word timestamps. Silent stretches are normal: a chunk with no speech yields no caption, and the result reports spokenChunks and silentChunks.' +
        jobNote,
      {
        source,
        start,
        duration,
        language: { type: 'string', maxLength: 32 },
        chunkSeconds: { type: 'number', minimum: 2, maximum: 30 }
      },
      ['source']
    ),
    tool(
      'cut',
      'Save a trimmed video clip with audio into a new scratch folder. The original remains intact.' +
        jobNote,
      { source, start, duration: { ...duration, maximum: 60 } },
      ['source']
    ),
    tool(
      'export',
      'Use only when the user explicitly requests an export or downloadable video file. The default deliverable is an editable composition and live preview; do not export automatically after creation, edits or critique. Export index.html and composition.json to MP4 with mixed audio, through a dedicated hidden renderer. Supports up to 4K pixel count. The renderer encodes H.264 for the canvas the composition names with CIOVideo.useCanvas, at the manifest size; a composition without that canvas falls back to capturing the window frame by frame. Await media seeks in cioRenderFrame.' +
        jobNote,
      { directory },
      ['directory']
    ),
    tool(
      'jobs',
      "Read this thread's video job states, progress, output files and errors. Jobs are retained for this app session.",
      {}
    ),
    tool(
      'runtime',
      'Install the CIO-authored standalone cio-video.js helpers beside a composition. Include it as a script and await CIOVideo.bind(draw). Exposes parameters, captions, the curve set in CIOVideo.easings, path reveals, pivots, tracking interpolation and exact media seeking. Refreshes a copy the app generated earlier when the runtime has changed, and never overwrites a file it did not generate.',
      { directory },
      ['directory']
    ),
    tool(
      'scaffold',
      'Start a composition from a film the app ships, copied into a project folder with the runtime installed beside it. The shipped film is a finished piece rather than a blank form, and its README carries the beat map and the list of what to replace. Refuses a folder that already holds a composition.',
      {
        starter: {
          type: 'string',
          description:
            'Name of a shipped film. This build ships product-launch, a fifteen second launch film in four beats.'
        },
        directory: {
          type: 'string',
          description: 'Project-relative folder to create, such as .cio/videos/launch.'
        }
      },
      ['starter', 'directory']
    ),
    tool(
      'studio',
      'Read or atomically update studio.json. Read first and send its revision with document to avoid overwriting concurrent user edits. Preserve existing edit and appearance fields. Fields: version:1, controls:[{key,label,kind:text|number|color|switch,value,min?,max?}], captions:[{text,start,end,words?:[{text,start,end}],appearance?}], captionStyle:none|plain|highlight|karaoke, captionAppearance?, audioTracks:[{source,start,trim,duration,gain}], edit?:source-preserving tracks/assets/clips/regions/changes. Times are seconds. Appearance includes normalized x/y/width, relative size, app font id, weight, color/background/backgroundOpacity. The shared runtime renders preview and export. Saves create history checkpoints.',
      { directory, document: { type: 'object' }, revision: { type: 'string' } },
      ['directory']
    ),
    tool(
      'captions',
      'Import captions JSON and optionally retime it after a cut. Accepts an array or an object with captions. from/to are source trim bounds; at is the placement on the composition timeline. Exact supplied word timestamps are preserved.',
      {
        directory,
        source,
        from: start,
        to: start,
        at: start,
        style: { type: 'string', enum: ['plain', 'highlight', 'karaoke', 'none'] }
      },
      ['directory']
    ),
    tool(
      'track',
      'Track a selected rectangular region by local appearance in an isolated worker. x,y,width,height are normalized source coordinates, with x/y at the top-left. Returns tracking.json with normalized center positions and confidence. This is template tracking, not semantic segmentation; review occlusions and low-confidence samples.' +
        jobNote,
      {
        source,
        start,
        duration: { ...duration, maximum: 60 },
        x: { type: 'number', minimum: 0, maximum: 1 },
        y: { type: 'number', minimum: 0, maximum: 1 },
        width: { type: 'number', minimum: 0.01, maximum: 1 },
        height: { type: 'number', minimum: 0.01, maximum: 1 }
      },
      ['source', 'x', 'y', 'width', 'height']
    ),
    tool(
      'remove-background',
      'Produce opaque base and transparent foreground WebM layers through local GPU matting. Processes a bounded 720p/30fps clip, up to 60 seconds. Needs the optional video pack, a one-time download from Settings > Design and video; the selected model downloads on first use into the app model cache, GPU support is checked, and failures are reported.' +
        jobNote,
      {
        source,
        start,
        duration: { ...duration, maximum: 60 },
        model: { type: 'string', enum: ['modnet', 'ben2-base'] }
      },
      ['source']
    )
  ]
  const tracking = tools.find((tool) => tool.name === 'track')!
  tools.push({
    ...tracking,
    name: 'analyze-motion',
    description:
      'Measure a selected region in a user-supplied recording and estimate its displacement, overshoot and nearest easing curve with fit error and tracking confidence. Coordinates and bounds match track. Uses the existing isolated tracking worker; no downloads. Choose one movement interval. Estimates do not recover original spring constants.' +
      jobNote
  })
  return tools
}
