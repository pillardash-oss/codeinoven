<script lang="ts">
  import CioFileText from '@codeinoven/icons/CioFileText.svelte'
  import CioWindow from '@codeinoven/icons/CioWindow.svelte'
  import { editorPreference } from '$lib/stores/editor-preference.svelte'

  type CallbackResult = void | Promise<void>

  interface Props {
    viewTitle: string
    openTitle: string
    busy: boolean
    onReveal?: () => CallbackResult
    onOpen?: () => CallbackResult
  }

  let { viewTitle, openTitle, busy, onReveal, onOpen }: Props = $props()

  let preferredIcon = $derived(editorPreference.preferredInfo?.iconDataUrl)
</script>

{#if onReveal}
  <button
    class="flex h-8 flex-1 items-center justify-center gap-2 px-2.5 text-xs font-medium text-muted hover:bg-elevated hover:text-foreground disabled:opacity-50"
    disabled={busy}
    title={viewTitle}
    onclick={() => void onReveal?.()}
  >
    <CioFileText size={13} />
    View
  </button>
{/if}
{#if onOpen}
  <button
    class="flex h-8 flex-1 items-center justify-center gap-2 px-2.5 text-xs font-medium text-muted hover:bg-elevated hover:text-foreground disabled:opacity-50"
    disabled={busy}
    title={openTitle}
    onclick={() => void onOpen?.()}
  >
    {#if preferredIcon}
      <img src={preferredIcon} alt="" class="h-3.5 w-3.5 shrink-0" />
    {:else}
      <CioWindow size={14} class="shrink-0" />
    {/if}
    Open
  </button>
{/if}
