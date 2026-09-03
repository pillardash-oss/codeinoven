<script lang="ts">
  import { Check, ChevronDown, History, Save } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import StudioHistoryControls from './StudioHistoryControls.svelte'

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
</script>

{#if versions.length > 1 && onSelectVersion}
<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-elevated hover:text-foreground"
    title={versionMenuTitle}
  >
    <History size={12} />
    Version {currentVersion}
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
<span>Updated {formatDate(updatedAt)}</span>
{#if statusLabel}
  <span
    class="rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide {statusClass ??
      'bg-raised text-dimmed'}">{statusLabel}</span
  >
{/if}
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
