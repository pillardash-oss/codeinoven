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
  return [
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
      'Transcribe footage with the installed ASR selected in Sounds. Caption timing uses measured audio chunks, not inferred word timestamps.' +
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
      'Export index.html and composition.json to MP4 with mixed audio, through a dedicated hidden renderer. Supports up to 4K pixel count. Await media seeks in cioRenderFrame.' +
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
      'Install the CIO-authored standalone cio-video.js helpers beside a composition. Include it as a script and await CIOVideo.bind(draw). Exposes parameters, captions, easing, path reveals, pivots, tracking interpolation and exact media seeking. Does not overwrite a different existing file.',
      { directory },
      ['directory']
    ),
    tool(
      'studio',
      'Read or atomically update studio.json. Read first and send its revision with document to avoid overwriting concurrent user edits. Fields: version:1, controls:[{key,label,kind:text|number|color|switch,value,min?,max?}], captions:[{text,start,end,words?:[{text,start,end}]}], captionStyle:plain|highlight|karaoke, audioTracks:[{source,start,trim,duration,gain}]. Times are seconds. The runtime reads these values and the user can edit controls in the video panel.',
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
        style: { type: 'string', enum: ['plain', 'highlight', 'karaoke'] }
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
      'Produce opaque base and transparent foreground WebM layers through local GPU matting. Processes a bounded 720p/30fps clip, up to 60 seconds. Downloads the selected model on first use into project scratch; GPU support is checked and failures are reported.' +
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
}
