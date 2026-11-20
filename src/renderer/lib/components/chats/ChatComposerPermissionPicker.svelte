<script lang="ts">
  import CioShield from '@pdslng/cio-icon/CioShield.svelte'
  import CioShieldAlert from '@pdslng/cio-icon/CioShieldAlert.svelte'
  import CioShieldCheck from '@pdslng/cio-icon/CioShieldCheck.svelte'
  import CioShieldOff from '@pdslng/cio-icon/CioShieldOff.svelte'
  import { permissionLevelLabel, permissionLevelsFor } from '$lib/actions'
  import { isOvenMode, isUnrestrictedLevel } from '$shared/permission-level'
  import type { PermissionLevel } from '$shared/types'

  interface Props {
    readOnlyMode: boolean
    hidePermissionSelector: boolean
    fileSystemMode: boolean | undefined
    permissionLevel: PermissionLevel
    /** True when the composer sends to an external Oven (a remote machine).
     *  Oven Mode is offered only there, because it exists so the agent can do
     *  anything on that machine. */
    oven: boolean
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
    oven,
    working,
    menuOpen,
    onToggle,
    onClose,
    onSelect
  }: Props = $props()

  /** The levels this composer may offer: Oven Mode joins the list only while the
   *  thread targets an external Oven, and always after Full Access. */
  let levels = $derived(permissionLevelsFor({ oven }))

  let ovenMode = $derived(isOvenMode(permissionLevel))
  let unrestricted = $derived(isUnrestrictedLevel(permissionLevel))

  /** The granted-everything tiers read as the color of their risk: Oven Mode is
   *  the strongest (destructive), Full Access the next one down. */
  function levelTone(id: PermissionLevel): string {
    if (isOvenMode(id)) return 'text-danger'
    return isUnrestrictedLevel(id) ? 'text-warning' : 'text-muted'
  }

  /** The row treatment a level gets in the open menu. */
  function levelRow(id: PermissionLevel, active: boolean): string {
    if (isOvenMode(id)) {
      return active ? 'bg-danger/10 font-bold text-danger' : 'text-muted hover:bg-danger/10'
    }
    if (isUnrestrictedLevel(id)) {
      return active ? 'font-bold text-warning' : 'text-muted hover:bg-elevated'
    }
    return active ? 'font-medium text-foreground' : 'text-muted hover:bg-elevated'
  }
</script>

<!-- Permission level selector -->
{#if readOnlyMode}
  <span
    class="flex h-8 shrink-0 items-center gap-1 overflow-hidden bg-raised px-2 text-[0.6875rem] whitespace-nowrap text-muted"
    title="Temporary chats can inspect context but cannot modify files or run commands"
  >
    <CioShield size={12} class="shrink-0" />
    <span class="composer-control-label min-w-0 truncate">Read only</span>
  </span>
{:else if !hidePermissionSelector || fileSystemMode === true}
  <!-- Keep the permission hit area intact while the model group shrinks. At the
       narrow tier the label drops out so the shield remains visible. -->
  <div class="relative shrink-0">
    <button
      type="button"
      class="flex h-8 min-w-0 max-w-full items-center gap-1 overflow-hidden px-2 text-[0.6875rem] whitespace-nowrap transition-colors {ovenMode
        ? 'bg-danger/10 font-bold text-danger'
        : unrestricted
          ? 'font-bold text-warning hover:bg-elevated'
          : 'text-muted hover:bg-elevated hover:text-foreground'}"
      aria-label={`Permission level: ${permissionLevelLabel(permissionLevel)}`}
      title={working
        ? 'Permission level for the next turn   the current run is unchanged'
        : ovenMode
          ? 'Oven Mode   this turn runs unrestricted on the external Oven'
          : 'Permission level   controls how tool-call permissions are handled'}
      onclick={onToggle}
    >
      {#if ovenMode}
        <CioShieldOff size={12} strokeWidth={2.75} class="shrink-0" />
      {:else if unrestricted}
        <CioShieldAlert size={12} strokeWidth={2.75} class="shrink-0" />
      {:else}
        <CioShield size={12} class="shrink-0" />
      {/if}
      <span class="composer-control-label min-w-0 truncate"
        >{permissionLevelLabel(permissionLevel)}</span
      >
    </button>

    {#if menuOpen}
      <button class="fixed inset-0 z-30 cursor-default" aria-label="Close menu" onclick={onClose}
      ></button>
      <div class="absolute bottom-9 left-0 z-40 w-36 border bg-surface p-1 shadow-lg">
        {#if working}
          <p class="px-2 pb-1 pt-1 text-[0.5625rem] text-dimmed">Applies to the next turn</p>
        {/if}
        {#each levels as level (level.id)}
          <button
            class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors {levelRow(
              level.id,
              permissionLevel === level.id
            )}"
            title={level.description}
            onclick={() => onSelect(level.id)}
          >
            {#if isOvenMode(level.id)}
              <CioShieldOff size={12} strokeWidth={2.75} class={levelTone(level.id)} />
            {:else if isUnrestrictedLevel(level.id)}
              <CioShieldAlert size={12} strokeWidth={2.75} class={levelTone(level.id)} />
            {:else}
              <CioShieldCheck size={12} class="text-info" />
            {/if}
            {level.label}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* The label drops out at the narrow tier so the permission control stays
     compact. The container is the parent composer (`.chat-composer`). */
  @container (max-width: 520px) {
    .composer-control-label {
      display: none;
    }
  }
</style>
