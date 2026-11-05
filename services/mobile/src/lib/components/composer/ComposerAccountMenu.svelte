<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'

  /**
   * The account a message runs as. A thread may name an account this phone is not
   * signed in with, so both are listed: the one in force is checked, and the
   * signed-in account is marked the default the phone can send as. A thread whose
   * account is already the signed-in one shows a single row, because a choice
   * with one answer is not worth a menu of one.
   */
  interface Props {
    selected: string
    /** The signed-in account, and the one this phone can always write as. */
    own: string
    onpick: (label: string) => void
  }

  let { selected, own, onpick }: Props = $props()

  let options = $derived(selected === own ? [own] : [selected, own])
</script>

<div class="cpanel account-menu" role="menu" aria-label="Account">
  {#each options as label (label)}
    <button
      class="account-item"
      type="button"
      role="menuitemradio"
      aria-checked={label === selected}
      title={`Run as ${label}`}
      onclick={() => onpick(label)}
    >
      <span class="ac-check"
        >{#if label === selected}<CioCheck size={11} />{/if}</span
      >
      <span class="ac-name">{label}</span>
      {#if label === own}<span class="ac-badge">Default</span>{/if}
    </button>
  {/each}
</div>
