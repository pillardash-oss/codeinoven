import { mount } from 'svelte'
import { toast } from 'svelte-sonner'
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

/**
 * The project-relative path the panel's reveal action lands on.
 *
 * The two exports report their files differently. A video export names files
 * already relative to the project root and leaves `directory` empty, so its MP4
 * is revealed directly. A design export names files relative to the folder it
 * created, so the folder has to be joined on before the path means anything in
 * the tree. An export that reported no files at all reveals that folder.
 */
export function exportRevealPath(kind: ExportKind, outcome: ExportOutcome): string | null {
  const first = outcome.files[0]
  if (kind === 'design') {
    if (!outcome.directory) return first ?? null
    return first ? `${outcome.directory}/${first}` : outcome.directory
  }
  return first ?? (outcome.directory || null)
}

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
  /** The project the reported export belongs to, so its Reveal action can find
   *  that project's own file tree. Kept across the export because the panel
   *  outlives the board that started it. */
  projectId = $state('')
  /** Whether the panel is landing the finished export in the file tree. */
  revealing = $state(false)
  private mounted = false
  /** Bumped on every new export so a superseded run stops writing to the panel. */
  private generation = 0

  /** Start a design export and report it in the panel. */
  startDesign(
    projectId: string,
    threadId: string,
    directory: string,
    entry: string | null,
    format: DesignExportFormat
  ): void {
    void this.runDesign(projectId, threadId, directory, entry, format)
  }

  /** Start a video MP4 export and report it in the panel. */
  startVideo(projectId: string, threadId: string, directory: string): void {
    void this.runVideo(projectId, threadId, directory)
  }

  private async runDesign(
    projectId: string,
    threadId: string,
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
    this.begin('design', `${entry ?? 'Whole design'} as ${format.toUpperCase()}`, projectId)
    try {
      const exported = await invoke('design:export', projectId, threadId, directory, entry, format)
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
    this.begin('video', VIDEO_EXPORT_LABEL, projectId)
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

  /**
   * Reveal what a finished export wrote in the exporting project's own file
   * tree, and dock the panel onto the tree it just brought on screen.
   *
   * The reveal is the app's existing one (`revealProjectFileFromAbsolutePath`):
   * it opens the files surface, expands the ancestors and selects the entry, so
   * an export lands in the same tree every other path citation uses instead of
   * a folder the user has to find again.
   */
  async revealInFileTree(): Promise<void> {
    const outcome = this.result
    const kind = this.kind
    const path = outcome && kind ? exportRevealPath(kind, outcome) : null
    if (!outcome || !kind || !this.projectId || !path || this.revealing) return
    this.revealing = true
    try {
      const { revealProjectFileFromAbsolutePath } = await import('$lib/reveal-file')
      const revealed = await revealProjectFileFromAbsolutePath(this.projectId, path)
      if (revealed) {
        // The tree is on screen now, and the panel floats over the right edge
        // where the sidebar just opened: dock it so it covers nothing the user
        // was sent to look at.
        this.minimized = true
        return
      }
      // The path exists (the export just wrote it) but the project's tree could
      // not show it, which is what a thread mounted on a worktree looks like:
      // the export writes under the project root, the tree reads the checkout.
      // The file manager can still show the file, so the action is not a
      // dead end.
      await this.revealInFileManager(path)
    } catch (failure: unknown) {
      // The export itself succeeded, so a failed reveal must not replace the
      // panel's report of it with an error card; it is reported beside it.
      logRendererError('The exported file could not be revealed.', failure)
      toast.error(
        failure instanceof Error
          ? failure.message
          : 'The exported file could not be revealed in the file tree.'
      )
    } finally {
      this.revealing = false
    }
  }

  /**
   * Last resort for a file the project's tree cannot show: hand it to the OS
   * file manager, which displays any existing path. A conversation mounted on a
   * worktree checkout reads a different root than the one the export wrote to,
   * so the tree is not always the right surface. Never throws over the panel's
   * report of a successful export.
   */
  private async revealInFileManager(path: string): Promise<void> {
    const project = await invoke('project:get', this.projectId).catch(() => null)
    const root = project?.path.replace(/\/+$/u, '')
    if (!root) {
      toast.error('The exported file could not be revealed in the file tree.')
      return
    }
    const { revealInOsFileManager } = await import('$lib/os-file-manager')
    const revealed = await revealInOsFileManager(`${root}/${path.replace(/^\/+/, '')}`)
    if (!revealed) {
      toast.error('The exported file could not be revealed in the file tree.')
    }
  }

  /** Reset the panel for a new export and bring it to the front. */
  private begin(kind: ExportKind, label: string, projectId: string): void {
    this.kind = kind
    this.label = label
    this.projectId = projectId
    this.revealing = false
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
