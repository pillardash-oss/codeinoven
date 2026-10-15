<script lang="ts">
  import { AudioLines, FileText, Image as ImageIcon, Video, X } from '@lucide/svelte'
  import { attachmentPreviewKind } from '$lib/mime'
  import type { PromptAttachment } from '$shared/types'

  interface Props {
    attachment: PromptAttachment
    /** The object URL the preview cache holds for this file, when it has one.
     *  An image leads with it; every other kind leads with its type's icon. */
    previewUrl?: string
    /** Opens the file fullscreen. Absent leaves the pill a label rather than a
     *  control, which is what a surface that only reports the file wants. */
    onPreview?: (attachment: PromptAttachment) => void
    /** Removes the file. Absent on a pill nothing can remove from, such as the
     *  files of a message already waiting in the queue. */
    onRemove?: () => void
  }

  let { attachment, previewUrl, onPreview, onRemove }: Props = $props()

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
>
  {#snippet label()}
    {#if previewKind === 'image'}
      {#if previewUrl}
        <img src={previewUrl} alt={name} class="h-5 w-5 shrink-0 object-cover" />
      {:else}
        <ImageIcon size={11} class="shrink-0" />
      {/if}
    {:else if previewKind === 'video'}
      <Video size={11} class="shrink-0" />
    {:else if previewKind === 'audio'}
      <AudioLines size={11} class="shrink-0" />
    {:else}
      <FileText size={11} class="shrink-0" />
    {/if}
    <span class="max-w-32 truncate">{name}</span>
  {/snippet}
  {#if previewKind && onPreview}
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
    <span class="flex min-w-0 items-center gap-1.5 py-1 pr-1 pl-2">
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
      <X size={11} />
    </button>
  {/if}
</div>
