<script lang="ts">
  import { Archive, Bell, Check, ChevronDown, CircleDot, History, Pencil, Save, TriangleAlert } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import StudioHistoryControls from './StudioHistoryControls.svelte'
  import type { Component } from 'svelte'

  interface Props {
    /** Status text is optional for studios without a per-version status (e.g. audit reports). */
    versions: Array<{ version: number; status?: string }>
    currentVersion: number
    updatedAt: number
    statusLabel?: string
    statusClass?: string
    dirty: boolean
    canUndo: boolean
    canRedo: boolean
    canSave: boolean
    busy: boolean
    savePending: boolean
    versionMenuTitle: string
    versionItemTitle: (version: number) => string
    /** When absent (or a single version), the version dropdown is hidden. */
    onSelectVersion?: (version: number) => void | Promise<void>
    onUndo: () => void
    onRedo: () => void
    onSave: () => void
  }

  let {
    versions,
    currentVersion,
    updatedAt,
    statusLabel,
    statusClass,
    dirty,
    canUndo,
    canRedo,
    canSave,
    busy,
    savePending,
    versionMenuTitle,
    versionItemTitle,
    onSelectVersion,
    onUndo,
    onRedo,
    onSave
  }: Props = $props()

  function formatDate(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(timestamp)
  }

  /** Equivalent single-glyph stand-in for the status badge in compact headers. */
  function statusIcon(statusLabel: string | undefined): Component | null {
    if (!statusLabel) return null
    const label = statusLabel.toLowerCase()
    if (/approv|final|passed|complete|sign/.test(label)) return Check
    if (/rework|required|fail|stop/.test(label)) return TriangleAlert
    if (/supersed|archiv/.test(label)) return Archive
    if (/draft|pending|review/.test(label)) return Pencil
    if (/progress|running|active|implement/.test(label)) return CircleDot
    return null
  }

  const compactStatusIcon = $derived(statusIcon(statusLabel))
</script>

{#if versions.length > 1 && onSelectVersion}
<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-elevated hover:text-foreground"
    title={versionMenuTitle}
  >
    <History size={12} />
    <span class="version-word">Version</span>
    {currentVersion}
    <ChevronDown size={11} />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="start"
      sideOffset={4}
      collisionPadding={8}
      strategy="fixed"
      class="z-50 max-h-52 min-w-44 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
    >
      {#each versions as version (version.version)}
        <DropdownMenu.Item
          class="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-elevated"
          textValue={`Version ${version.version}`}
          title={versionItemTitle(version.version)}
          onSelect={() => void onSelectVersion(version.version)}
        >
          <span>Version {version.version}</span>
          <span class="flex items-center gap-1.5 capitalize text-dimmed">
            {#if version.status}{version.status}{/if}
            {#if version.version === currentVersion}<Check size={11} class="text-primary" />{/if}
          </span>
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
{/if}
<StudioHistoryControls {canUndo} {canRedo} onUndo={onUndo} onRedo={onRedo} />
<span class="updated-text">Updated {formatDate(updatedAt)}</span>
<span
  class="updated-icon text-muted"
  title={`Updated ${formatDate(updatedAt)}`}
  aria-label={`Updated ${formatDate(updatedAt)}`}>
  <Bell size={12} />
</span>
{#if statusLabel}
  {#if compactStatusIcon}
    {@const CompactStatusIcon = compactStatusIcon}
    <span
      class="status-icon rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide {statusClass ??
        'bg-raised text-dimmed'}"
      title={statusLabel}
      aria-label={statusLabel}>
      <CompactStatusIcon size={11} />
    </span>
  {/if}
  <span
    class="status-text rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide {statusClass ??
      'bg-raised text-dimmed'}">{statusLabel}</span
  >
{/if}

<style>
  .status-icon,
  .updated-icon {
    display: none;
  }

  /* When the coordinator panel squeezes the studio header, collapse the
     version bar to icons: history glyph + version number, a bell for the
     update stamp, and a single status glyph. */
  @container studio-header (max-width: 1100px) {
    .version-word,
    .updated-text,
    .status-text {
      display: none;
    }

    .updated-icon {
      display: inline-flex;
      align-items: center;
    }

    .status-icon {
      display: inline-flex;
      align-items: center;
    }
  }
</style>
{#if dirty && canSave}
  <button
    class="flex items-center gap-1 rounded-md border bg-elevated px-2 py-1 text-[11px] font-medium hover:bg-overlay disabled:opacity-50"
    disabled={busy || savePending}
    title="Save changes (Cmd/Ctrl+S)"
    onclick={onSave}
  >
    <Save size={11} />
    Save
  </button>
{/if}
