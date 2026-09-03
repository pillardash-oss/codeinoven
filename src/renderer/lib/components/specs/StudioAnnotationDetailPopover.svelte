<script lang="ts">
  import { Check, Pencil, X } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import PopoverDragHandle from '../ui/PopoverDragHandle.svelte'
  import { compactViewport } from '$lib/compact-viewport.svelte'
  import { draggablePopover } from '$lib/draggable-popover.svelte'
  import type { SpeechScope } from '../../../../lib/speech/types'

  type CallbackResult = void | Promise<void>

  interface Props {
    position: { x: number; y: number }
    annotation: { id: string; quote?: string; body: string; author: string; createdAt: number }
    canEdit: boolean
    /** When true the annotation body renders as an editable markdown editor. */
    editorMode: boolean
    headerLabel: string
    dialogLabel: string
    /** Speech target id used for the edit editor. */
    speechTargetId: string
    scope: SpeechScope
    body?: string
    onResolve?: () => CallbackResult
    onSave?: () => CallbackResult
    /** Exits edit mode; renders a Cancel button while editing. */
    onCancelEdit?: () => void
    /** Enters edit mode; renders an Edit button when editable and not editing. */
    onEditClick?: () => void
    onClose: () => void
    /** Optional custom read-only body renderer (e.g. markdown view); receives the annotation. */
    bodyView?: Snippet<[Props['annotation']]>
  }

  let {
    position,
    annotation,
    canEdit,
    editorMode,
    headerLabel,
    dialogLabel,
    speechTargetId,
    scope,
    body = $bindable(''),
    onResolve,
    onSave,
    onCancelEdit,
    onEditClick,
    onClose,
    bodyView
  }: Props = $props()

  let editor = $state<RichMarkdownEditor>()

  function speechTarget() {
    return editor?.speechEditorTarget(speechTargetId) ?? null
  }

  function formatDate(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(timestamp)
  }
</script>

<div
  class="fixed z-50 w-80 rounded-xl border bg-surface p-4 shadow-xl max-md:inset-x-0 max-md:bottom-0 max-md:w-auto max-md:rounded-b-none max-md:pb-[calc(1rem+env(safe-area-inset-bottom))]"
  role="dialog"
  aria-label={dialogLabel}
  {@attach draggablePopover({
    x: position.x,
    y: position.y,
    disabled: compactViewport.matches
  })}
>
  <div class="flex items-center justify-between gap-2">
    <span class="flex min-w-0 items-center gap-1">
      {#if !compactViewport.matches}
        <PopoverDragHandle title="Move annotation" />
      {/if}
      <span class="text-[10px] font-semibold uppercase tracking-wide text-muted">
        {headerLabel}
      </span>
    </span>
    <button
      class="rounded-md p-1 text-muted hover:bg-overlay hover:text-foreground"
      title="Close annotation"
      aria-label="Close annotation"
      onclick={onClose}><X size={13} /></button
    >
  </div>
  {#if annotation.quote}
    <blockquote
      class="mt-2 line-clamp-3 border-l-2 border-accent pl-2 text-[11px] leading-relaxed text-muted"
    >
      “{annotation.quote}”
    </blockquote>
  {/if}
  {#if editorMode}
    <RichMarkdownEditor
      bind:this={editor}
      class="mt-3 min-h-24 w-full resize-y rounded-lg border bg-elevated px-3 py-2 text-xs outline-none focus:border-primary"
      bind:value={body}
      ariaLabel="Annotation body"
      onSubmit={() => void onSave?.()}
    />
  {:else if bodyView}
    {@render bodyView(annotation)}
  {:else}
    <p class="mt-3 text-xs leading-relaxed text-foreground">{annotation.body}</p>
  {/if}
  <p class="mt-1 text-[10px] text-dimmed">
    {annotation.author} · {formatDate(annotation.createdAt)}
  </p>
  <div class="mt-3 flex items-center justify-between">
    {#if canEdit && onResolve}
      <button
        class="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-success hover:bg-success/10"
        title="Resolve annotation"
        onclick={onResolve}
      >
        <Check size={12} />
        Resolve
      </button>
    {:else}
      <span></span>
    {/if}
    <div class="flex gap-1.5">
      {#if editorMode}
        {#if onCancelEdit}
          <button
            class="rounded-lg px-2.5 py-1.5 text-xs text-muted hover:bg-overlay"
            title="Cancel editing"
            onclick={onCancelEdit}>Cancel</button
          >
        {/if}
        <VoiceInputButton
          targetId={speechTargetId}
          getTarget={speechTarget}
          {scope}
        />
        {#if onSave}
          <button
            class="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50"
            disabled={!body.trim()}
            title="Save annotation"
            onclick={() => void onSave?.()}>Save</button
          >
        {/if}
      {:else if canEdit && onEditClick}
        <button
          class="flex items-center gap-1 rounded-lg border bg-elevated px-2.5 py-1.5 text-xs font-semibold hover:bg-overlay"
          title="Edit annotation"
          onclick={onEditClick}><Pencil size={12} /> Edit</button
        >
      {/if}
    </div>
  </div>
</div>
