<script lang="ts">
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioPlug from '@pdslng/cio-icon/CioPlug.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import { onMount } from 'svelte'
  import { ipcErrorMessage } from '$lib/ipc-errors'
  import { acpAgentsStore } from '$lib/stores/acp-agents.svelte'
  import { schemeState } from '$lib/stores/scheme.svelte'
  import { APP_NAME } from '$shared/brand'
  import type { AcpAgentStatus } from '$shared/acp'
  import SettingsStatusBadge from '../shared/SettingsStatusBadge.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'

  /**
   * The agents the user added over the Agent Client Protocol.
   *
   * A row carries only what the app resolved on this machine: where the command
   * lives, or why it cannot be started. Nothing here installs, updates or
   * uninstalls, because there is no install: an agent is a command the user
   * already has, so a row offers Edit and Delete only.
   */
  interface Props {
    /** Free-text filter from the page header, over name, command and path. */
    query?: string
  }

  let { query = '' }: Props = $props()

  /** The agent awaiting delete confirmation. Removal is never silent. */
  let deleteTarget = $state<AcpAgentStatus | null>(null)
  let removing = $state(false)
  let removeError = $state('')

  const agents = $derived(acpAgentsStore.settings?.agents ?? [])
  const filtered = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return agents
    return agents.filter(
      (agent) =>
        agent.name.toLowerCase().includes(needle) ||
        agent.command.toLowerCase().includes(needle) ||
        (agent.resolvedPath?.toLowerCase().includes(needle) ?? false)
    )
  })

  /** The light icon on light surfaces, the dark variant on dark ones. */
  function iconFor(agent: AcpAgentStatus): string | undefined {
    return schemeState.isDark ? (agent.iconDark ?? agent.icon) : agent.icon
  }

  /** Why the command did not resolve, in the app's own words. */
  function issueFor(agent: AcpAgentStatus): string {
    return agent.detail ?? `"${agent.command}" was not found on PATH.`
  }

  async function confirmRemove(): Promise<void> {
    const target = deleteTarget
    if (!target || removing) return
    removing = true
    removeError = ''
    try {
      await acpAgentsStore.remove(target.id)
      deleteTarget = null
    } catch (error) {
      removeError = ipcErrorMessage(error, `${target.name} could not be removed.`)
    } finally {
      removing = false
    }
  }

  function cancelRemove(): void {
    if (removing) return
    deleteTarget = null
    removeError = ''
  }

  onMount(() => {
    void acpAgentsStore.load()
  })
</script>

{#if acpAgentsStore.error}
  <div class="border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
    {acpAgentsStore.error}
  </div>
{/if}

{#if acpAgentsStore.settings === null}
  {#if !acpAgentsStore.error}
    <p class="text-xs text-dimmed">Loading ACP agents…</p>
  {/if}
{:else if agents.length === 0}
  <div class="flex flex-wrap items-center justify-between gap-4 border border-dashed p-6">
    <div class="flex min-w-0 items-start gap-3">
      <CioPlug size={20} class="mt-0.5 shrink-0 text-dimmed" aria-hidden="true" />
      <div class="min-w-0">
        <p class="text-sm font-medium">No ACP agents yet</p>
        <p class="mt-0.5 text-xs text-muted">
          Runs any harness that speaks the Agent Client Protocol. Add one with the command that
          starts it.
        </p>
      </div>
    </div>
    <button
      type="button"
      class="flex shrink-0 items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
      title="Add an ACP agent"
      onclick={() => acpAgentsStore.openNew()}
    >
      <CioPlus size={13} />
      Add agent
    </button>
  </div>
{:else if filtered.length === 0}
  <div class="border border-dashed p-6 text-center text-xs text-dimmed">
    No agents match the current filter.
  </div>
{:else}
  <div class="@container space-y-3">
    {#each filtered as agent (agent.id)}
      {@const resolved = agent.resolvedPath !== undefined}
      {@const icon = iconFor(agent)}
      <div
        class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border bg-surface p-4 @5xl:grid-cols-[minmax(0,1fr)_auto_auto] @5xl:gap-3"
      >
        <div class="flex min-w-0 items-center gap-3">
          <div
            class="flex h-9 w-9 shrink-0 items-center justify-center border border-border bg-elevated"
          >
            {#if icon}
              <img src={icon} alt="" class="h-full w-full object-contain" />
            {:else}
              <CioPlug size={20} class="text-dimmed" aria-hidden="true" />
            {/if}
          </div>
          <div class="min-w-0">
            <p class="truncate text-sm font-medium">{agent.name}</p>
            {#if agent.resolvedPath}
              <p class="truncate font-mono text-xs text-dimmed" title={agent.resolvedPath}>
                {agent.resolvedPath}
              </p>
            {:else}
              <p class="truncate text-xs text-danger" title={issueFor(agent)}>{issueFor(agent)}</p>
            {/if}
          </div>
        </div>

        <div class="min-w-0 shrink-0">
          <SettingsStatusBadge
            label={resolved ? 'Ready' : 'Command not found'}
            classes={resolved
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-danger/30 bg-danger/10 text-danger'}
          >
            {#if resolved}
              <CioCheckCircle size={12} class="shrink-0" />
            {:else}
              <CioAttention size={12} class="shrink-0" />
            {/if}
          </SettingsStatusBadge>
        </div>

        <div class="col-span-2 flex items-center justify-end gap-2 @5xl:col-span-1">
          <button
            type="button"
            class="flex shrink-0 items-center gap-1.5 border bg-elevated px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-overlay hover:text-foreground"
            title="Edit {agent.name}"
            onclick={() => acpAgentsStore.openEdit(agent.id)}
          >
            <CioPencil size={13} />
            Edit
          </button>
          <button
            type="button"
            class="flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
            title="Remove {agent.name}"
            onclick={() => {
              removeError = ''
              deleteTarget = agent
            }}
          >
            <CioTrash size={13} />
            Delete
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

{#if deleteTarget}
  <ConfirmDialog
    open
    title={`Remove ${deleteTarget.name}?`}
    confirmLabel="Remove agent"
    variant="danger"
    busy={removing}
    onCancel={cancelRemove}
    onConfirm={confirmRemove}
  >
    <p>
      {deleteTarget.name} stops appearing in the harness list, and any thread pinned to it must pick another
      harness. Nothing is uninstalled from your machine, and {APP_NAME} keeps the rest of your data.
    </p>
    {#if removeError}
      <p class="text-xs text-danger">{removeError}</p>
    {/if}
  </ConfirmDialog>
{/if}
