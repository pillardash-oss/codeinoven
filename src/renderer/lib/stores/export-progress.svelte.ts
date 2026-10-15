import { mount } from 'svelte'
import { invoke } from '$lib/ipc.svelte'
import { logRendererError } from '$lib/system/renderer-logger'
import type { DesignExportFormat } from '$shared/design/design-export'
import type { VideoJob } from '$shared/video/studio'

/**
 * What one finished export left behind.
 *
 * A design export writes a whole folder, so it reports that folder and the files
 * inside it. A video export writes files under the project's own `.cio` work
 * folder, so it reports them alone and leaves `directory` empty.
 */
export interface ExportOutcome {
  /** The folder a design export wrote to, empty for a video export. */
  directory: string
  /** The files the export wrote, relative to the project root. */
  files: string[]
}

/** Which export the one panel is reporting on. */
export type ExportKind = 'design' | 'video'

/** The label a video export carries, phrased for the user rather than the code. */
const VIDEO_EXPORT_LABEL = 'Composition as MP4'
/** How often a running video export is re-read; the job is not push-based. */
const VIDEO_POLL_INTERVAL = 700
/**
 * Roughly 35 minutes of polling.
 *
 * A video job has a 30 minute deadline of its own, so this only fires if the job
 * stopped reporting entirely (for example its thread was closed) and keeps the
 * loop from spinning forever.
 */
const VIDEO_POLL_LIMIT = 3000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The one export the app reports on, whichever surface started it.
 *
 * Exporting anything for design and video opens the app's dockable panel
 * (`components/design/ExportProgress.svelte`), never a regular modal: the panel
 * floats, docks to a screen edge, and keeps reporting while the user works
 * elsewhere. This controller owns the state that panel reads.
 *
 * One export runs at a time, because the app can only run one video job at a
 * time and a design export is a short-lived renderer call, so a second request
 * brings the running panel back in front instead of starting a rival report. A
 * `generation` token lets a superseded run stop writing to the panel without
 * needing an abortable signal.
 */
class ExportProgressState {
  /** Whether the panel is on screen at all. */
  open = $state(false)
  /** Whether the panel is collapsed into its dock chip. */
  minimized = $state(false)
  /** Whether an export is in flight. */
  running = $state(false)
  /** Which export the panel is describing, or null before the first one. */
  kind = $state<ExportKind | null>(null)
  /** What is being exported, in the user's terms. */
  label = $state('')
  /** The running video export's own stage line; empty for a design export. */
  stage = $state('')
  /** How far a running video export has come, 0..1. */
  progress = $state(0)
  /** The refusal that stopped the export, when the export failed. */
  error = $state('')
  /** What a finished export wrote. */
  result = $state<ExportOutcome | null>(null)
  private mounted = false
  /** Bumped on every new export so a superseded run stops writing to the panel. */
  private generation = 0

  /** Start a design export and report it in the panel. */
  startDesign(
    projectId: string,
    directory: string,
    entry: string | null,
    format: DesignExportFormat
  ): void {
    void this.runDesign(projectId, directory, entry, format)
  }

  /** Start a video MP4 export and report it in the panel. */
  startVideo(projectId: string, threadId: string, directory: string): void {
    void this.runVideo(projectId, threadId, directory)
  }

  private async runDesign(
    projectId: string,
    directory: string,
    entry: string | null,
    format: DesignExportFormat
  ): Promise<void> {
    if (this.running) {
      this.reveal()
      return
    }
    if (!(await this.mountPanel())) return
    if (this.running) {
      this.reveal()
      return
    }
    const generation = ++this.generation
    this.begin('design', `${entry ?? 'Whole design'} as ${format.toUpperCase()}`)
    try {
      const exported = await invoke('design:export', projectId, directory, entry, format)
      if (this.generation !== generation) return
      this.result = { directory: exported.directory, files: exported.files }
    } catch (failure: unknown) {
      if (this.generation !== generation) return
      logRendererError('Design export failed.', failure)
      this.error = failure instanceof Error ? failure.message : 'The design could not be exported.'
    } finally {
      if (this.generation === generation) this.settle()
    }
  }

  private async runVideo(projectId: string, threadId: string, directory: string): Promise<void> {
    if (this.running) {
      this.reveal()
      return
    }
    if (!(await this.mountPanel())) return
    if (this.running) {
      this.reveal()
      return
    }
    const generation = ++this.generation
    this.begin('video', VIDEO_EXPORT_LABEL)
    this.stage = 'Starting'
    try {
      // The export runs in main as a job, so its progress is read back until it
      // settles rather than awaited here.
      await invoke('video:export', projectId, threadId, directory)
      let polls = 0
      while (this.generation === generation) {
        await sleep(VIDEO_POLL_INTERVAL)
        if (this.generation !== generation) return
        const job = await this.readExportJob(projectId, threadId)
        if (this.generation !== generation) return
        polls += 1
        if (!job) {
          // The job was trimmed away or never registered; stop rather than spin.
          if (polls > 10) throw new Error('The export stopped reporting progress.')
          continue
        }
        this.stage = job.stage
        this.progress = job.progress
        if (job.state === 'running') {
          if (polls > VIDEO_POLL_LIMIT) throw new Error('The export took longer than expected.')
          continue
        }
        if (job.state === 'completed') this.result = { directory: '', files: job.files }
        else if (job.state === 'cancelled') this.error = 'The export was cancelled.'
        else this.error = job.error ?? 'The export failed.'
        return
      }
    } catch (failure: unknown) {
      if (this.generation !== generation) return
      logRendererError('Video export failed.', failure)
      this.error =
        failure instanceof Error ? failure.message : 'The composition could not be exported.'
    } finally {
      if (this.generation === generation) this.settle()
    }
  }

  /** The newest export job for a thread, which is the one just started. */
  private async readExportJob(projectId: string, threadId: string): Promise<VideoJob | null> {
    const jobs = await invoke('video:jobs', projectId, threadId)
    for (let index = jobs.length - 1; index >= 0; index -= 1) {
      if (jobs[index].operation === 'export') return jobs[index]
    }
    return null
  }

  /** Reset the panel for a new export and bring it to the front. */
  private begin(kind: ExportKind, label: string): void {
    this.kind = kind
    this.label = label
    this.stage = ''
    this.progress = 0
    this.error = ''
    this.result = null
    this.running = true
    this.reveal()
  }

  /** Mark the export finished, keeping its report on screen. */
  private settle(): void {
    this.running = false
    this.stage = ''
  }

  private reveal(): void {
    this.open = true
    this.minimized = false
  }

  /** Mount the panel once, so nothing but the first export pays for its chunk. */
  private async mountPanel(): Promise<boolean> {
    if (this.mounted) return true
    try {
      const { default: ExportProgress } =
        await import('$lib/components/design/ExportProgress.svelte')
      if (!this.mounted) {
        mount(ExportProgress, { target: document.body })
        this.mounted = true
      }
      return true
    } catch (failure: unknown) {
      logRendererError('The export panel could not be opened.', failure)
      return false
    }
  }
}

export const exportProgressState = new ExportProgressState()
