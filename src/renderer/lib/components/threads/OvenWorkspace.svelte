<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { Thread } from '$shared/types'
  import type { OvenFile, OvenState, OvenTransferReview } from '$shared/ovens'
  import { isThreadBusyStatus } from '$shared/thread-status-policy'
  import { LOCAL_OVEN_ID } from '$shared/ovens'
  import Modal from '../ui/Modal.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'

  interface Props {
    open: boolean
    embedded?: boolean
    ovenId: string
    root: string
    thread: Thread
    ovens: OvenState | null
    onClose: () => void
    onUseRoot: (root: string) => Promise<void>
  }
  let { open, embedded = false, ovenId, root, thread, ovens, onClose, onUseRoot }: Props = $props()
  const uid = $props.id()
  let workspaceRoot = $state('')
  let path = $state('')
  let files = $state.raw<OvenFile[]>([])
  let after = $state<string | undefined>()
  let text = $state('')
  let filename = $state('')
  let original = $state('')
  let busy = $state(false)
  let error = $state('')
  let preview = $state('')
  let previewPort = $state(5173)
  let source = $state(LOCAL_OVEN_ID)
  let sourceRoot = $state('')
  let target = $state('')
  let destination = $state('')
  let review = $state<OvenTransferReview | null>(null)
  let confirmSave = $state(false)
  let cloneUrl = $state('')

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return
    busy = true
    error = ''
    try {
      await action()
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The Oven operation failed.'
    } finally {
      busy = false
    }
  }

  async function list(more = false): Promise<void> {
    const result = await invoke('oven:workspace', ovenId, {
      operation: 'list',
      root: workspaceRoot,
      path,
      after: more ? after : undefined
    })
    files = more ? [...files, ...(result.files ?? [])] : (result.files ?? [])
    after = result.after
  }

  onMount(() => {
    void run(async () => {
      const probe = await invoke('oven:probe', ovenId)
      workspaceRoot =
        root || `${probe.home}/.config/pillardash/codeinoven-oven/workspaces/${thread.id}`
      sourceRoot = (await invoke('project:get', thread.projectId))?.path ?? ''
      target = ovenId
      destination = workspaceRoot
      await invoke('oven:workspace', ovenId, { operation: 'ensure', root: workspaceRoot })
      await list()
    })
  })

  function decode(data: string): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    )
  }

  function encode(value: string): string {
    const bytes = new TextEncoder().encode(value)
    if (bytes.length > 128 * 1024) throw new Error('Editor saves are limited to 128 KiB.')
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }

  async function read(file: OvenFile): Promise<void> {
    if (file.kind === 'directory') {
      path = file.path
      await list()
      return
    }
    if (file.kind === 'symlink')
      throw new Error('Open the linked file within the workspace instead.')
    if (file.size > 128 * 1024)
      throw new Error(
        'Editor previews are limited to 128 KiB. Use a preview link for larger files.'
      )
    const result = await invoke('oven:workspace', ovenId, {
      operation: 'read',
      root: workspaceRoot,
      path: file.path,
      offset: 0
    })
    text = decode(result.data ?? '')
    original = text
    filename = file.path
  }

  async function save(): Promise<void> {
    confirmSave = false
    await run(async () => {
      // Check the complete original before replacing, so a harness edit is never
      // replaced without a freshness check. The service checks again at replacement.
      const current = await invoke('oven:workspace', ovenId, {
        operation: 'read',
        root: workspaceRoot,
        path: filename,
        offset: 0
      })
      if (decode(current.data ?? '') !== original)
        throw new Error('The file changed on the Oven. Reload it before saving.')
      const staged = `${filename}.${crypto.randomUUID()}.next`
      await invoke('oven:workspace', ovenId, {
        operation: 'write',
        root: workspaceRoot,
        path: staged,
        offset: 0,
        data: encode(text),
        exclusive: true
      })
      const info = await invoke('oven:workspace', ovenId, {
        operation: 'stat',
        root: workspaceRoot,
        path: filename
      })
      await invoke('oven:workspace', ovenId, {
        operation: 'replace',
        root: workspaceRoot,
        path: filename,
        staged,
        mode: info.file?.mode ?? 0o600,
        expectedData: encode(original)
      })
      original = text
    })
  }
</script>

{#snippet workspaceBody()}
  <div class="space-y-4">
    <form
      class="flex gap-2"
      onsubmit={(event) => {
        event.preventDefault()
        void run(async () => {
          path = ''
          await list()
        })
      }}
    >
      <input
        aria-label="Workspace directory on the Oven"
        title="Workspace directory on the Oven"
        class="min-w-0 flex-1 rounded-lg border bg-elevated px-3 py-2 font-mono text-sm"
        bind:value={workspaceRoot}
      />
      <button type="submit" class="rounded-lg border px-3 py-2 text-sm" disabled={busy}>Open</button
      >
    </form>
    <button
      type="button"
      class="rounded-lg border px-3 py-2 text-xs"
      disabled={busy || isThreadBusyStatus(thread.status)}
      onclick={() => void run(() => onUseRoot(workspaceRoot))}>Use directory for this chat</button
    >
    <div class="flex flex-wrap gap-2 text-xs">
      <button
        type="button"
        class="rounded-lg border px-3 py-1.5"
        disabled={busy}
        onclick={() =>
          void run(async () => {
            path = path.split('/').slice(0, -1).join('/')
            await list()
          })}>Parent</button
      >
      {#each ['status', 'diff', 'log'] as action (action)}
        <button
          type="button"
          class="rounded-lg border px-3 py-1.5"
          disabled={busy}
          onclick={() =>
            void run(async () => {
              text =
                (
                  await invoke('oven:workspace', ovenId, {
                    operation: 'git',
                    root: workspaceRoot,
                    action: action as 'status' | 'diff' | 'log'
                  })
                ).text ?? ''
              filename = ''
            })}>Git {action}</button
        >
      {/each}
      <button
        type="button"
        class="rounded-lg border px-3 py-1.5"
        disabled={busy}
        onclick={() =>
          void run(async () => {
            preview = await invoke('oven:preview', ovenId, workspaceRoot)
          })}>Create preview link</button
      >
    </div>
    <form
      class="flex items-center gap-2"
      onsubmit={(event) => {
        event.preventDefault()
        void run(async () => {
          preview = await invoke('oven:previewPort', ovenId, previewPort)
        })
      }}
    >
      <label class="text-xs text-muted" for={`${uid}-preview-port`}>Server port</label>
      <input
        id={`${uid}-preview-port`}
        type="number"
        min="1"
        max="65535"
        class="w-24 rounded-lg border bg-elevated px-2 py-1 text-xs"
        bind:value={previewPort}
      />
      <button type="submit" class="rounded-lg border px-3 py-1.5 text-xs" disabled={busy}
        >Preview running app</button
      >
    </form>
    {#if preview}<a
        href={preview}
        target="_blank"
        rel="noreferrer"
        class="block truncate text-xs text-primary"
        title="Open Oven preview in the browser">{preview}</a
      >{/if}
    <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div class="max-h-64 overflow-auto rounded-lg border p-2">
        <p class="mb-2 truncate font-mono text-xs text-muted">/{path}</p>
        {#each files as file (file.path)}
          <button
            type="button"
            class="block w-full truncate rounded-md px-2 py-1 text-left font-mono text-xs hover:bg-elevated"
            disabled={busy}
            title={`Open ${file.path}`}
            onclick={() => void run(() => read(file))}
            >{file.kind === 'directory' ? '▸ ' : ''}{file.path.split('/').at(-1)}</button
          >
        {/each}
        {#if after}<button
            type="button"
            class="mt-2 text-xs text-primary"
            disabled={busy}
            onclick={() => void run(() => list(true))}>Load more</button
          >{/if}
      </div>
      <div class="space-y-2">
        <p class="truncate font-mono text-xs text-muted">{filename || 'Git output'}</p>
        <textarea
          aria-label="Remote file contents or Git output"
          class="h-64 w-full resize-y rounded-lg border bg-elevated p-3 font-mono text-xs"
          bind:value={text}
          readonly={!filename}></textarea>
        {#if filename}<button
            type="button"
            class="rounded-lg border px-3 py-1.5 text-xs"
            disabled={busy || text === original}
            onclick={() => (confirmSave = true)}>Save file on Oven</button
          >{/if}
      </div>
    </div>
    <form
      class="space-y-2 rounded-lg border p-3"
      onsubmit={(event) => {
        event.preventDefault()
        void run(async () => {
          await invoke('oven:workspace', ovenId, {
            operation: 'clone',
            root: destination,
            url: cloneUrl
          })
          workspaceRoot = destination
          path = ''
          await list()
        })
      }}
    >
      <p class="text-xs font-medium">Clone a repository on this Oven</p>
      <input
        aria-label="Git repository URL"
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-xs"
        bind:value={cloneUrl}
        placeholder="git@github.com:owner/repository.git"
      />
      <input
        aria-label="New destination directory"
        class="w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs"
        bind:value={destination}
        placeholder="~/projects/new-directory"
      />
      <button
        type="submit"
        class="rounded-lg border px-3 py-1.5 text-xs"
        disabled={busy || !cloneUrl || !destination}>Clone repository</button
      >
    </form>
    <form
      class="space-y-2 rounded-lg border p-3"
      onsubmit={(event) => {
        event.preventDefault()
        void run(async () => {
          review = await invoke('oven:reviewTransfer', {
            sourceOvenId: source,
            sourceRoot,
            targetOvenId: target,
            targetRoot: destination
          })
        })
      }}
    >
      <p class="text-xs font-medium">Transfer repository or assets</p>
      <select
        aria-label="Transfer source Oven"
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-xs"
        bind:value={source}
        >{#each ovens?.ovens ?? [] as oven (oven.id)}<option value={oven.id}>{oven.name}</option
          >{/each}</select
      >
      <input
        aria-label="Source directory"
        class="w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs"
        bind:value={sourceRoot}
        placeholder="Source directory"
      />
      <select
        aria-label="Transfer destination Oven"
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-xs"
        bind:value={target}
      >
        {#each ovens?.ovens ?? [] as oven (oven.id)}
          <option value={oven.id}>{oven.name}</option>
        {/each}
      </select>
      <input
        aria-label="Transfer destination directory"
        class="w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs"
        bind:value={destination}
        placeholder="New directory on this Oven"
      />
      <p class="text-xs text-dimmed">
        Includes Git history and unfinished changes. The destination must be new. Temporary .cio
        files stay on their source.
      </p>
      <button
        type="submit"
        class="rounded-lg border px-3 py-1.5 text-xs"
        disabled={busy || !sourceRoot || !destination}>Review transfer</button
      >
    </form>
    {#if busy}<p class="text-xs text-muted" role="status">Working on the Oven…</p>{/if}
    {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}
  </div>
{/snippet}

{#if embedded}
  <div class="h-full overflow-y-auto p-3">{@render workspaceBody()}</div>
{:else}
  <Modal {open} title="Oven workspace" {onClose} size="xl">
    {@render workspaceBody()}
    {#snippet footer()}<button
        type="button"
        data-modal-primary
        class="rounded-lg bg-primary px-4 py-2 text-sm text-on-primary"
        onclick={onClose}>Close</button
      >{/snippet}
  </Modal>
{/if}

<ConfirmDialog
  open={confirmSave}
  title="Save file on Oven?"
  confirmLabel="Save file"
  onConfirm={() => void save()}
  onCancel={() => (confirmSave = false)}
  ><p>Replace {filename} with your edited contents?</p></ConfirmDialog
>
<ConfirmDialog
  open={Boolean(review)}
  title="Transfer to Oven?"
  confirmLabel="Transfer files"
  onConfirm={() => {
    const pending = review
    review = null
    if (pending)
      void run(async () => {
        await invoke('oven:transfer', pending.id)
        if (pending.targetOvenId === ovenId) {
          workspaceRoot = pending.targetRoot
          path = ''
          await list()
        }
      })
  }}
  onCancel={() => (review = null)}
  ><p>
    {review
      ? `Copy ${review.files} files (${(review.bytes / 1024 / 1024).toFixed(1)} MiB) from ${review.sourceRoot} to ${review.targetRoot}? The source stays unchanged.`
      : ''}
  </p></ConfirmDialog
>
