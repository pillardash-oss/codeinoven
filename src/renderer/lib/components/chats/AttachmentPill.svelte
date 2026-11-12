<script lang="ts">
  import CioAudioLines from '@pdslng/cio-icon/CioAudioLines.svelte'
  import CioClapper from '@pdslng/cio-icon/CioClapper.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioFileText from '@pdslng/cio-icon/CioFileText.svelte'
  import CioImage from '@pdslng/cio-icon/CioImage.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { attachmentPreviewKind } from '$lib/mime'
  import type { PromptAttachment } from '$shared/types'

  interface Props {
    attachment: PromptAttachment
    /** The object URL the preview cache holds for this file, when it has one.
     *  An image leads with it; every other kind leads with its type's icon. */
    previewUrl?: string
    /** True while the file is still being stored. The pill then states what is
     *  arriving and spins instead of offering a preview the file cannot answer. */
    pending?: boolean
    /** Opens the file fullscreen. Absent leaves the pill a label rather than a
     *  control, which is what a surface that only reports the file wants. */
    onPreview?: (attachment: PromptAttachment) => void
    /** Removes the file. Absent on a pill nothing can remove from, such as the
     *  files of a message already waiting in the queue. */
    onRemove?: () => void
  }

  let { attachment, previewUrl, pending = false, onPreview, onRemove }: Props = $props()

  const name = $derived(attachment.filename ?? 'file')
  /** Null for a file nothing in the app can render, which is what makes the
   *  pill a plain label instead of a preview control. */
  const previewKind = $derived(attachmentPreviewKind(attachment.mime, name))
</script>

<!-- One attached file: what it is, what opening it does, and how it leaves. The
     leading segment is the icon or the picture, the trailing one is the remove
     control, and each reads the same wherever the file is listed. -->
<div
  class="flex items-stretch overflow-hidden border border-border bg-elevated text-[0.6875rem] text-muted transition-colors"
  aria-busy={pending || undefined}
>
  {#snippet label()}
    {#if pending}
      <CioSpinner size={11} class="shrink-0 animate-spin" />
    {:else if previewKind === 'image'}
      {#if previewUrl}
        <img src={previewUrl} alt={name} class="h-5 w-5 shrink-0 object-cover" />
      {:else}
        <CioImage size={11} class="shrink-0" />
      {/if}
    {:else if previewKind === 'video'}
      <CioClapper size={11} class="shrink-0" />
    {:else if previewKind === 'audio'}
      <CioAudioLines size={11} class="shrink-0" />
    {:else}
      <CioFileText size={11} class="shrink-0" />
    {/if}
    <span class="max-w-32 truncate">{name}</span>
  {/snippet}
  {#if previewKind && onPreview && !pending}
    <button
      type="button"
      class="flex min-w-0 items-center gap-1.5 py-1 pr-1 pl-2 text-left transition-colors hover:text-foreground"
      title={`Preview ${name}`}
      aria-label={`Preview ${name}`}
      onclick={() => onPreview(attachment)}
    >
      {@render label()}
    </button>
  {:else}
    <span
      class="flex min-w-0 items-center gap-1.5 py-1 pr-1 pl-2"
      title={pending ? `Adding ${name}` : undefined}
    >
      {@render label()}
    </span>
  {/if}
  {#if onRemove}
    <button
      type="button"
      class="flex shrink-0 items-center justify-center border-l border-border px-2.5 text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
      title={`Remove ${name}`}
      aria-label={`Remove ${name}`}
      onclick={onRemove}
    >
      <CioClose size={11} />
    </button>
  {/if}
</div>
