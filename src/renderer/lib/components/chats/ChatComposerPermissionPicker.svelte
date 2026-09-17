<script lang="ts">
  import { Shield, ShieldAlert, ShieldCheck } from '@lucide/svelte'
  import { PERMISSION_LEVELS, permissionLevelLabel } from '$lib/actions'
  import type { PermissionLevel } from '$shared/types'

  interface Props {
    readOnlyMode: boolean
    hidePermissionSelector: boolean
    fileSystemMode: boolean | undefined
    permissionLevel: PermissionLevel
    working: boolean
    menuOpen: boolean
    onToggle: () => void
    onClose: () => void
    onSelect: (level: PermissionLevel) => void
  }

  let {
    readOnlyMode,
    hidePermissionSelector,
    fileSystemMode,
    permissionLevel,
    working,
    menuOpen,
    onToggle,
    onClose,
    onSelect
  }: Props = $props()
</script>

<!-- Permission level selector -->
{#if readOnlyMode}
  <span
    class="flex min-w-0 items-center gap-1 overflow-hidden rounded-lg bg-raised px-2 py-1.5 text-[0.6875rem] whitespace-nowrap text-muted"
    title="Temporary chats can inspect context but cannot modify files or run commands"
  >
    <Shield size={12} class="shrink-0" />
    <span class="composer-control-label min-w-0 truncate">Read only</span>
  </span>
{:else if !hidePermissionSelector || fileSystemMode === true}
  <!-- Shrinkable: the label ellipsizes instead of wrapping, and disappears
       entirely at the narrow tier so only the shield icon remains. -->
  <div class="relative min-w-0 shrink">
    <button
      type="button"
      class="flex min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-lg px-2 py-1.5 text-[0.6875rem] whitespace-nowrap transition-colors hover:bg-elevated {permissionLevel ===
      'full_access'
        ? 'font-bold text-warning'
        : 'text-muted hover:text-foreground'}"
      aria-label={`Permission level: ${permissionLevelLabel(permissionLevel)}`}
      title={working
        ? 'Permission level for the next turn   the current run is unchanged'
        : 'Permission level   controls how tool-call permissions are handled'}
      onclick={onToggle}
    >
      {#if permissionLevel === 'full_access'}
        <ShieldAlert size={12} strokeWidth={2.75} class="shrink-0" />
      {:else}
        <Shield size={12} class="shrink-0" />
      {/if}
      <span class="composer-control-label min-w-0 truncate"
        >{permissionLevelLabel(permissionLevel)}</span
      >
    </button>

    {#if menuOpen}
      <button class="fixed inset-0 z-30 cursor-default" aria-label="Close menu" onclick={onClose}
      ></button>
      <div class="absolute bottom-9 left-0 z-40 w-36 rounded-xl border bg-surface p-1 shadow-lg">
        {#if working}
          <p class="px-2 pb-1 pt-1 text-[0.5625rem] text-dimmed">Applies to the next turn</p>
        {/if}
        {#each PERMISSION_LEVELS as level (level.id)}
          <button
            class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-elevated {permissionLevel ===
            level.id
              ? level.id === 'full_access'
                ? 'font-bold text-warning'
                : 'font-medium text-foreground'
              : 'text-muted'}"
            title={level.description}
            onclick={() => onSelect(level.id)}
          >
            {#if level.id === 'full_access'}
              <ShieldAlert size={12} strokeWidth={2.75} class="text-warning" />
            {:else}
              <ShieldCheck size={12} class="text-info" />
            {/if}
            {level.label}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* The label ellipsizes as the composer tightens; at the narrow tier it drops
     out entirely so only the shield icon remains. The container is the parent
     composer (`.chat-composer`), so this query resolves against it. */
  @container (max-width: 520px) {
    .composer-control-label {
      display: none;
    }
  }
</style>
