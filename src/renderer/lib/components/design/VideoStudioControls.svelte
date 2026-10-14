<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import type { VideoJob, VideoStudioDocument, VideoValue } from '$shared/video/studio'

  interface Props {
    projectId: string
    threadId: string
    directory: string
  }
  let { projectId, threadId, directory }: Props = $props()
  let document = $state<VideoStudioDocument | null>(null)
  let revision = ''
  let jobs = $state.raw<VideoJob[]>([])
  let error = $state('')
  let busy = $state(false)
  let dirty = $state(false)
  let cancelledJob = $state<VideoJob | null>(null)
  let reloadRequested = $state(false)
  let captionPage = $state(0)
  let visibleCaptions = $derived(
    document?.captions.slice(captionPage * 25, captionPage * 25 + 25) ?? []
  )
  let mounted = false
  let readingJobs = false
  let panel: HTMLElement | null = null
  const labels: Record<string, string> = {
    filmstrip: 'Footage frames',
    waveform: 'Waveform',
    listen: 'Audio excerpt',
    transcribe: 'Transcription',
    cut: 'Video cut',
    export: 'Video export',
    track: 'Motion tracking',
    'remove-background': 'Background removal'
  }
  function primaryAction(event: KeyboardEvent): void {
    if (
      !(event.target instanceof Node) ||
      !panel?.contains(event.target) ||
      cancelledJob ||
      !keymapState.matches('video-primary-action', event)
    )
      return
    event.preventDefault()
    event.stopPropagation()
    if (dirty) void save()
    else void exportVideo()
  }

  async function load(): Promise<void> {
    busy = true
    try {
      const result = await invoke('video:studio', projectId, directory)
      if (!mounted) return
      document = result.document
      revision = result.revision
      dirty = false
      error = ''
      captionPage = 0
    } catch (cause) {
      if (mounted) error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (mounted) busy = false
    }
  }
  async function readJobs(): Promise<void> {
    if (readingJobs || !mounted) return
    readingJobs = true
    try {
      const result = await invoke('video:jobs', projectId, threadId)
      if (mounted) jobs = result.slice(-6)
    } catch (cause) {
      if (mounted) error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      readingJobs = false
    }
  }
  onMount(() => {
    mounted = true
    void load()
    void readJobs()
    const timer = setInterval(() => {
      void readJobs()
    }, 1500)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  })
  function setControl(key: string, value: VideoValue): void {
    const control = document?.controls.find((item) => item.key === key)
    if (control) {
      control.value = value
      dirty = true
    }
  }
  async function save(): Promise<void> {
    if (!document || busy) return
    busy = true
    try {
      const result = await invoke(
        'video:save',
        projectId,
        directory,
        $state.snapshot(document),
        revision
      )
      document = result.document
      revision = result.revision
      dirty = false
      error = ''
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy = false
    }
  }
  async function exportVideo(): Promise<void> {
    if (busy || dirty) return
    busy = true
    try {
      await invoke('video:export', projectId, threadId, directory)
      await readJobs()
      error = ''
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy = false
    }
  }
  async function cancel(): Promise<void> {
    if (!cancelledJob) return
    try {
      await invoke('video:cancel', projectId, threadId, cancelledJob.id)
      cancelledJob = null
      await readJobs()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }
</script>

<svelte:window onkeydown={primaryAction} />
<section
  {@attach (node) => {
    panel = node
    return () => {
      panel = null
    }
  }}
  class="mb-3 space-y-2 border-b border-border pb-3"
  aria-label="Video controls"
>
  <div class="flex items-center justify-between gap-2">
    <span class="text-xs font-semibold">Video controls</span>
    <button
      type="button"
      class="rounded border border-border px-2 py-1 text-xs hover:bg-elevated disabled:opacity-50"
      disabled={busy}
      onclick={() => {
        if (dirty) reloadRequested = true
        else void load()
      }}
      title="Reload saved video controls">Reload</button
    >
    <button
      type="button"
      class="rounded bg-primary px-2 py-1 text-xs text-on-primary disabled:opacity-50"
      disabled={busy || dirty || jobs.some((job) => job.state === 'running')}
      onclick={() => void exportVideo()}>Export MP4</button
    >
  </div>
  {#if error}<p role="alert" class="text-xs text-danger">{error}</p>{/if}
  {#if document}
    <form
      class="space-y-2"
      onsubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <fieldset disabled={busy} class="space-y-2">
        <legend class="sr-only">Composition settings</legend>
        {#each document.controls as control (control.key)}
          <div class="flex items-center justify-between gap-2 text-xs">
            {#if control.kind === 'switch'}
              <Switch
                checked={control.value === true}
                label={control.label}
                title={control.label}
                aria-label={control.label}
                onchange={(value) => setControl(control.key, value)}
              />
            {:else}
              <label for={`video-${control.key}`}>{control.label}</label>
              <input
                id={`video-${control.key}`}
                class="w-36 rounded border border-border bg-elevated px-2 py-1 text-xs"
                type={control.kind === 'number'
                  ? 'number'
                  : control.kind === 'color'
                    ? 'color'
                    : 'text'}
                value={String(control.value)}
                min={control.min}
                max={control.max}
                step="any"
                oninput={(event) =>
                  setControl(
                    control.key,
                    control.kind === 'number'
                      ? Number(event.currentTarget.value)
                      : event.currentTarget.value
                  )}
              />
            {/if}
          </div>
        {/each}
        {#if document.captions.length}
          <details class="text-xs">
            <summary class="cursor-pointer">Captions ({document.captions.length})</summary>
            <label class="mt-2 flex items-center justify-between gap-2"
              >Style
              <select
                class="rounded border border-border bg-elevated p-1 text-xs"
                bind:value={document.captionStyle}
                onchange={() => {
                  dirty = true
                }}
              >
                <option value="plain">Plain</option><option value="highlight">Highlight word</option
                ><option value="karaoke">Karaoke</option>
              </select>
            </label>
            {#each visibleCaptions as caption (caption)}
              <div class="mt-2 space-y-1">
                <label class="block"
                  >Caption at {caption.start.toFixed(2)}s
                  <textarea
                    class="mt-1 w-full rounded border border-border bg-elevated p-1 text-xs"
                    rows="2"
                    bind:value={caption.text}
                    oninput={() => {
                      caption.words = undefined
                      dirty = true
                    }}></textarea>
                </label>
                <div class="flex gap-2">
                  <label class="flex min-w-0 items-center gap-1"
                    >Start
                    <input
                      type="number"
                      class="w-20 rounded border border-border bg-elevated p-1 text-xs"
                      min="0"
                      step="0.01"
                      bind:value={caption.start}
                      onchange={() => {
                        caption.words = undefined
                        dirty = true
                      }}
                    />
                  </label>
                  <label class="flex min-w-0 items-center gap-1"
                    >End
                    <input
                      type="number"
                      class="w-20 rounded border border-border bg-elevated p-1 text-xs"
                      min="0"
                      step="0.01"
                      bind:value={caption.end}
                      onchange={() => {
                        caption.words = undefined
                        dirty = true
                      }}
                    />
                  </label>
                </div>
              </div>
            {/each}
            {#if document.captions.length > 25}
              <div class="mt-2 flex justify-between">
                <button
                  type="button"
                  disabled={captionPage === 0}
                  onclick={() => {
                    captionPage -= 1
                  }}>Previous</button
                >
                <button
                  type="button"
                  disabled={(captionPage + 1) * 25 >= document.captions.length}
                  onclick={() => {
                    captionPage += 1
                  }}>Next</button
                >
              </div>
            {/if}
          </details>
        {/if}
        {#if document.audioTracks.length}
          <details class="text-xs">
            <summary class="cursor-pointer">Audio tracks ({document.audioTracks.length})</summary>
            {#each document.audioTracks as track (track)}
              <div class="mt-2 space-y-1">
                <p class="truncate">{track.source}</p>
                <div class="flex flex-wrap gap-2">
                  {#each ['start', 'trim', 'duration', 'gain'] as field (field)}
                    {@const key = field as 'start' | 'trim' | 'duration' | 'gain'}
                    <label class="flex items-center gap-1"
                      >{field}
                      <input
                        type="number"
                        class="w-16 rounded border border-border bg-elevated p-1 text-xs"
                        min="0"
                        step="0.01"
                        bind:value={track[key]}
                        onchange={() => {
                          dirty = true
                        }}
                      />
                    </label>
                  {/each}
                </div>
              </div>
            {/each}
          </details>
        {/if}
      </fieldset>
      {#if dirty}<button
          type="submit"
          disabled={busy}
          class="rounded bg-primary px-2 py-1 text-xs text-on-primary disabled:opacity-50"
          >Save changes</button
        >{/if}
    </form>
  {/if}
  {#each jobs as job (job.id)}
    <div class="space-y-1 text-xs">
      <div class="flex justify-between gap-2">
        <span>{labels[job.operation] ?? 'Video processing'}: {job.stage}</span>
        {#if job.state === 'running'}<button
            type="button"
            class="text-danger"
            onclick={() => {
              cancelledJob = job
            }}>Cancel</button
          >{/if}
      </div>
      {#if job.state === 'running'}<progress
          class="h-1 w-full accent-primary"
          value={job.progress}
          max="1"
          aria-label={`${job.operation} progress`}
        ></progress>{/if}
      {#if job.error}<p class="text-danger">{job.error}</p>{/if}
      {#each job.files as file (file)}<p class="break-all text-muted">{file}</p>{/each}
    </div>
  {/each}
</section>

<ConfirmDialog
  open={cancelledJob !== null}
  title="Cancel video processing?"
  confirmLabel="Cancel processing"
  cancelLabel="Keep processing"
  onCancel={() => {
    cancelledJob = null
  }}
  onConfirm={cancel}
>
  <p>The unfinished output will be discarded. Your source footage and composition will be kept.</p>
</ConfirmDialog>
<ConfirmDialog
  open={reloadRequested}
  title="Discard unsaved video controls?"
  confirmLabel="Discard and reload"
  onCancel={() => {
    reloadRequested = false
  }}
  onConfirm={() => {
    reloadRequested = false
    void load()
  }}
>
  <p>Your unsaved control and caption edits will be replaced with the saved version.</p>
</ConfirmDialog>
