<script lang="ts">
  import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioStop from '@pdslng/cio-icon/CioStop.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import SettingsDisclosure from '../../shared/SettingsDisclosure.svelte'
  import SettingsEntry from '../../shared/SettingsEntry.svelte'
  import SettingsStatusBadge from '../../shared/SettingsStatusBadge.svelte'
  import type { MenuItem } from '../../shared/ThreadDropdown.svelte'
  import ThreadDropdown from '../../shared/ThreadDropdown.svelte'
  import {
    describeLlamaServerCommand,
    llamaCppModelLabel,
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
    notice: string
    expanded: boolean
    onToggle: () => void
    onStart: () => void
    onStop: () => void
    onEdit: () => void
    onDelete: () => void
  }

  let {
    entry,
    executable,
    status,
    logLines,
    loadedModel,
    notice,
    expanded,
    onToggle,
    onStart,
    onStop,
    onEdit,
    onDelete
  }: Props = $props()

  let copied = $state(false)

  const command = $derived(describeLlamaServerCommand(entry, executable))
  const logText = $derived(
    logLines.length > 0
      ? logLines.join('\n')
      : 'No output yet. Start the server to see its log here.'
  )
  const busy = $derived(status === 'starting' || status === 'running')

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
    { label: 'Edit server', icon: CioPencil, disabled: busy, onClick: onEdit },
    { label: 'remove-divider', divider: true },
    { label: 'Remove server', icon: CioTrash, danger: true, onClick: onDelete }
  ])

  async function copyAddress(): Promise<void> {
    await invoke('clipboard:writeText', `${entry.host}:${entry.port}`)
    copied = true
    setTimeout(() => (copied = false), 1_500)
  }

  /**
   * Keep the newest line in view while output streams in, without pinning the
   * scroll position when the user has scrolled back to read something. An
   * attachment watches the tail's own text, so no state is assigned here.
   */
  function followLog(node: HTMLPreElement): () => void {
    const sync = (): void => {
      if (node.scrollHeight - node.scrollTop - node.clientHeight < 40) {
        node.scrollTop = node.scrollHeight
      }
    }
    const observer = new MutationObserver(sync)
    observer.observe(node, { childList: true, characterData: true, subtree: true })
    sync()
    return () => observer.disconnect()
  }
</script>

<SettingsEntry {expanded}>
  <div
    class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 @5xl:grid-cols-[minmax(8rem,12rem)_auto_minmax(8rem,1fr)_minmax(6rem,11rem)_auto] @5xl:gap-3"
  >
    <div class="flex min-w-0 items-center gap-3">
      <div
        class="flex h-9 w-9 shrink-0 items-center justify-center border border-border bg-elevated"
      >
        <VendorIcon name="llama.cpp" id="llamacpp" size={20} />
      </div>
      <div class="min-w-0">
        <p class="truncate text-sm font-medium">{entry.name}</p>
        <p class="truncate text-[0.625rem] text-dimmed" title={llamaCppModelLabel(entry)}>
          {llamaCppModelLabel(entry)}
        </p>
      </div>
    </div>

    <div class="min-w-0 shrink-0">
      {#key badge.label}
        <SettingsStatusBadge label={badge.label} classes={badge.classes}>
          <badge.Icon size={12} class="shrink-0 {badge.spin ? 'animate-spin' : ''}" />
        </SettingsStatusBadge>
      {/key}
    </div>

    <div class="col-span-2 min-w-0 @5xl:col-span-1">
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

    <div class="col-span-2 min-w-0 @5xl:col-span-1">
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

    <div
      class="col-span-2 flex flex-wrap items-center justify-end gap-2 @5xl:col-span-1 @5xl:flex-nowrap"
    >
      {#if busy}
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

      <SettingsDisclosure
        {expanded}
        title={`${expanded ? 'Hide' : 'Show'} ${entry.name} log`}
        onclick={onToggle}
      />
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
      <div class="border bg-raised">
        <p class="px-3 pt-2 text-[0.6875rem] font-medium uppercase tracking-wide text-dimmed">
          Log
        </p>
        <pre
          {@attach followLog}
          class="max-h-64 min-h-24 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 font-mono text-[0.6875rem] leading-relaxed text-muted">{logText}</pre>
      </div>
    </div>
  {/if}
</SettingsEntry>
