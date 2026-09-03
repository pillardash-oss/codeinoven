<script lang="ts">
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import PopoverDragHandle from '../ui/PopoverDragHandle.svelte'
  import StudioSelectionActions from './StudioSelectionActions.svelte'
  import { compactViewport } from '$lib/compact-viewport.svelte'
  import { draggablePopover } from '$lib/draggable-popover.svelte'
  import type { SpeechScope } from '../../../../lib/speech/types'

  type CallbackResult = void | Promise<void>

  interface Props {
    position: { x: number; y: number }
    quote: string
    canAnnotate: boolean
    showSelectionActions: boolean
    busy: boolean
    /** Speech target id used for the annotation editor. */
    speechTargetId: string
    dialogLabel: string
    headerLabel: string
    editorLabel: string
    body?: string
    scope: SpeechScope
    onSubmit: () => CallbackResult
    onCancel: () => void
    onExplain?: () => void
    onQuickChat?: () => void
  }

  let {
    position,
    quote,
    canAnnotate,
    showSelectionActions,
    busy,
    speechTargetId,
    dialogLabel,
    headerLabel,
    editorLabel,
    body = $bindable(''),
    scope,
    onSubmit,
    onCancel,
    onExplain,
    onQuickChat
  }: Props = $props()

  let editor = $state<RichMarkdownEditor>()

  function speechTarget() {
    return editor?.speechEditorTarget(speechTargetId) ?? null
  }
</script>

<div
  class="fixed z-50 w-96 rounded-xl border bg-surface p-3 shadow-xl max-md:inset-x-0 max-md:bottom-0 max-md:w-auto max-md:rounded-b-none max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
  role="dialog"
  aria-label={dialogLabel}
  {@attach draggablePopover({
    x: position.x,
    y: position.y,
    disabled: compactViewport.matches
  })}
>
  <div class="flex items-center gap-1">
    {#if !compactViewport.matches}
      <PopoverDragHandle title="Move selection comment" />
    {/if}
    <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">{headerLabel}</p>
  </div>
  <blockquote
    class="mt-2 line-clamp-3 border-l-2 border-accent pl-2 text-[11px] leading-relaxed text-muted"
  >
    “{quote}”
  </blockquote>
  {#if canAnnotate}
    <RichMarkdownEditor
      bind:this={editor}
      class="mt-2 min-h-16 w-full resize-y rounded-lg border bg-elevated px-2.5 py-2 text-xs outline-none focus:border-primary"
      bind:value={body}
      placeholder="Leave your review note…"
      ariaLabel={editorLabel}
      onSubmit={onSubmit}
    />
  {/if}
  <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
    {#if showSelectionActions && onExplain && onQuickChat}
      <StudioSelectionActions {onExplain} {onQuickChat} />
    {/if}
    <div class="ml-auto flex items-center gap-1.5">
      <button
        class="rounded-lg px-2.5 py-1.5 text-xs text-muted hover:bg-overlay"
        title="Cancel annotation"
        onclick={onCancel}>Cancel</button
      >
      {#if canAnnotate}
        <VoiceInputButton
          targetId={speechTargetId}
          getTarget={speechTarget}
          {scope}
          disabled={busy}
        />
        <button
          class="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50"
          disabled={busy || !body.trim()}
          title="Add annotation"
          onclick={onSubmit}>Comment</button
        >
      {/if}
    </div>
  </div>
</div>
