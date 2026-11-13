<script lang="ts">
  import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioFolderOpen from '@pdslng/cio-icon/CioFolderOpen.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioStop from '@pdslng/cio-icon/CioStop.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { formatBytes } from '$lib/format/bytes'
  import { osFileManagerLabel } from '$lib/os-file-manager'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import LocalAiServerLog from './LocalAiServerLog.svelte'
  import SettingsDisclosure from '../../shared/SettingsDisclosure.svelte'
  import SettingsEntry from '../../shared/SettingsEntry.svelte'
  import SettingsStatusBadge from '../../shared/SettingsStatusBadge.svelte'
  import type { MenuItem } from '../../shared/ThreadDropdown.svelte'
  import ThreadDropdown from '../../shared/ThreadDropdown.svelte'
  import {
    describeLocalAiServerCommand,
    localAiModelLabel,
    type LlamaCppServerEntry
  } from '$shared/llama-cpp'
  import { slide } from 'svelte/transition'
  import type { LlamaCppServerStatus } from './local-ai-controller.svelte'

  interface Props {
    entry: LlamaCppServerEntry
    executable: string
    status: LlamaCppServerStatus
    logLines: string[]
    loadedModel: string
    /** Bytes the model occupies on disk, undefined until it has been measured. */
    modelSize?: number | undefined
    notice: string
    expanded: boolean
    onToggle: () => void
    onStart: () => void
    onStop: () => void
    onEdit: () => void
    onDelete: () => void
    /** Show the model's file or folder in the OS file manager. */
    onReveal: () => void
    /** False for a row the app only registers, never launches. */
    managed?: boolean
  }

  let {
    entry,
    executable,
    status,
    logLines,
    loadedModel,
    modelSize,
    notice,
    expanded,
    onToggle,
    onStart,
    onStop,
    onEdit,
    onDelete,
    onReveal,
    managed = true
  }: Props = $props()

  let copied = $state(false)

  const command = $derived(describeLocalAiServerCommand(entry, executable))
  const busy = $derived(status === 'starting' || status === 'running')
  /** A row saved from a Hugging Face tag names nothing on disk yet, so there is
   *  no file to reveal and no size to measure until its download lands. */
  const localPath = $derived(entry.modelPath.trim())
  const sizeLabel = $derived(
    localPath.length === 0
      ? 'Not downloaded'
      : modelSize === undefined
        ? 'Measuring…'
        : modelSize > 0
          ? formatBytes(modelSize)
          : 'Unavailable'
  )

  const badge = $derived.by(() => {
    if (status === 'running') {
      return {
        Icon: CioCheckCircle,
        label: 'Running',
        classes: 'border-success/30 bg-success/10 text-success',
        spin: false
      }
    }
    if (status === 'starting') {
      return {
        Icon: CioSpinner,
        label: 'Starting…',
        classes: 'border-info/30 bg-info/10 text-info',
        spin: true
      }
    }
    if (status === 'failed') {
      return {
        Icon: CioStop,
        label: 'Failed',
        classes: 'border-danger/30 bg-danger/10 text-danger',
        spin: false
      }
    }
    return {
      Icon: CioPlay,
      label: 'Stopped',
      classes: 'border-border bg-raised text-muted',
      spin: false
    }
  })

  const menuItems = $derived.by<MenuItem[]>(() => [
    {
      label: osFileManagerLabel(),
      icon: CioFolderOpen,
      disabled: localPath.length === 0,
      onClick: onReveal
    },
    { label: 'Edit server', icon: CioPencil, disabled: busy, onClick: onEdit },
    { label: 'remove-divider', divider: true },
    { label: 'Remove server', icon: CioTrash, danger: true, onClick: onDelete }
  ])

  async function copyAddress(): Promise<void> {
    await invoke('clipboard:writeText', `${entry.host}:${entry.port}`)
    copied = true
    setTimeout(() => (copied = false), 1_500)
  }
</script>

<SettingsEntry {expanded}>
  <!-- Same shape as the runtime row above it: the name and the controls it
       acts on share one line, and only the details below reflow. -->
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
    <div class="flex min-w-0 flex-1 basis-48 items-center gap-3">
      <div
        class="flex h-9 w-9 shrink-0 items-center justify-center border border-border bg-elevated"
      >
        <VendorIcon
          name={entry.runtime === 'mlx' ? 'Apple' : 'llama.cpp'}
          id={entry.runtime === 'mlx' ? 'apple' : 'llamacpp'}
          size={20}
        />
      </div>
      <div class="min-w-0">
        <p class="truncate text-sm font-medium">{entry.name}</p>
        <p class="truncate text-[0.625rem] text-dimmed" title={localAiModelLabel(entry)}>
          {localAiModelLabel(entry)}
        </p>
      </div>
    </div>

    <div class="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
      {#if managed}
        {#key badge.label}
          <SettingsStatusBadge label={badge.label} classes={badge.classes}>
            <badge.Icon size={12} class="shrink-0 {badge.spin ? 'animate-spin' : ''}" />
          </SettingsStatusBadge>
        {/key}
      {/if}

      {#if !managed}
        <!-- Nothing to start: the process belongs to the user's own tooling. -->
      {:else if busy}
        <button
          class="flex shrink-0 items-center gap-1.5 whitespace-nowrap border px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Stop {entry.name}"
          onclick={onStop}
        >
          <CioStop size={13} />
          Stop
        </button>
      {:else}
        <button
          class="flex shrink-0 items-center gap-1.5 whitespace-nowrap bg-primary px-2.5 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
          title="Start {entry.name} and stream its log"
          onclick={onStart}
        >
          <CioPlay size={13} />
          Start
        </button>
      {/if}

      <ThreadDropdown
        items={menuItems}
        title="{entry.name} actions"
        ariaLabel="{entry.name} actions"
      />

      {#if managed}
        <SettingsDisclosure
          {expanded}
          title={`${expanded ? 'Hide' : 'Show'} ${entry.name} log`}
          onclick={onToggle}
        />
      {/if}
    </div>
  </div>

  <div class="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 @2xl:grid-cols-3">
    <div class="min-w-0">
      <p class="truncate text-[0.625rem] font-medium uppercase tracking-wide text-dimmed">
        Address
      </p>
      <div class="mt-0.5 flex items-center gap-1.5">
        <span class="min-w-0 truncate font-mono text-xs text-muted">
          {entry.host}:{entry.port}
        </span>
        <button
          type="button"
          class="flex h-5 w-5 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="Copy address"
          aria-label="Copy {entry.name} address"
          onclick={() => void copyAddress()}
        >
          {#if copied}
            <CioCheckCircle size={11} class="text-success" />
          {:else}
            <CioCopy size={11} />
          {/if}
        </button>
      </div>
    </div>

    <div class="min-w-0">
      <p class="truncate text-[0.625rem] font-medium uppercase tracking-wide text-dimmed">
        Loaded model
      </p>
      <p
        class="mt-0.5 truncate text-xs {loadedModel ? 'font-mono text-success' : 'text-dimmed'}"
        title={loadedModel}
      >
        {loadedModel || (status === 'running' ? 'No model reported' : 'Not loaded')}
      </p>
    </div>

    <div class="min-w-0">
      <p class="truncate text-[0.625rem] font-medium uppercase tracking-wide text-dimmed">
        Model size
      </p>
      <p
        class="mt-0.5 truncate text-xs {modelSize ? 'text-muted' : 'text-dimmed'}"
        title={localPath.length > 0
          ? localPath
          : 'Measured once a Hugging Face model is downloaded'}
      >
        {sizeLabel}
      </p>
    </div>
  </div>

  {#if expanded}
    <div class="mt-3 space-y-2 border-t border-border pt-3" transition:slide={{ duration: 150 }}>
      <div class="border bg-raised p-3">
        <p class="text-[0.6875rem] font-medium uppercase tracking-wide text-dimmed">Command</p>
        <p class="mt-1 break-all font-mono text-[0.6875rem] leading-relaxed text-muted">
          {command}
        </p>
      </div>
      {#if status === 'failed' && notice}
        <div class="border border-danger/30 bg-danger/10 p-3">
          <p class="text-[0.6875rem] font-medium uppercase tracking-wide text-danger">
            The server could not start
          </p>
          <pre
            class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.6875rem] leading-relaxed text-danger/90">{notice}</pre>
        </div>
      {/if}
      <div class="space-y-1.5">
        <p class="px-3 text-[0.6875rem] font-medium uppercase tracking-wide text-dimmed">Log</p>
        <LocalAiServerLog
          entryId={entry.id}
          history={logLines}
          emptyLabel="No output yet. Start the server to see its log here."
        />
      </div>
    </div>
  {/if}
</SettingsEntry>
