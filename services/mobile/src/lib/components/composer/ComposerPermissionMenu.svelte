<script lang="ts">
  import CioShieldAlert from '@pdslng/cio-icon/CioShieldAlert.svelte'
  import CioShieldCheck from '@pdslng/cio-icon/CioShieldCheck.svelte'
  import { PERMISSION_OPTIONS } from '#lib/composer-choice'
  import type { PermissionLevel } from '#lib/api/types'

  /**
   * The permission level this message runs at. Two levels, the same pair the
   * desktop offers: review every tool call, or run without asking. The chosen
   * row is the one in force, in its own ink.
   */
  interface Props {
    selected: PermissionLevel
    onpick: (level: PermissionLevel) => void
  }

  let { selected, onpick }: Props = $props()
</script>

<div class="cpanel perm-menu" role="menu" aria-label="Permission level">
  {#each PERMISSION_OPTIONS as option (option.id)}
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected === option.id}
      data-level={option.id}
      title={option.id === 'full_access'
        ? 'Run every tool call without asking'
        : 'Review each tool call before it runs'}
      onclick={() => onpick(option.id)}
    >
      {#if option.tone === 'warn'}
        <CioShieldAlert class="warn" size={12} />
      {:else}
        <CioShieldCheck class="info" size={12} />
      {/if}
      {option.label}
    </button>
  {/each}
</div>
