<script lang="ts">
  import { tick } from 'svelte'
  import CioArrowUp from '@pdslng/cio-icon/CioArrowUp.svelte'
  import CioCpu from '@pdslng/cio-icon/CioCpu.svelte'
  import CioHarness from '@pdslng/cio-icon/CioHarness.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioMinimize from '@pdslng/cio-icon/CioMinimize.svelte'
  import { composerHasThirdLine, composerShowsExpandControl } from '#shared/composer-expand'
  import { api, ApiError } from '#lib/api/client'
  import { statusSkin, toneColor } from '#lib/api/status'
  import type { Project, Prompt, Thread } from '#lib/api/types'

  /**
   * The composer writes into the thread and states what it is writing into, the
   * same readings the desktop composer carries under its editor: the thread's
   * state, the model, the harness, and the project. The service fixes the model
   * and harness per thread, so on a phone they are readings rather than pickers,
   * and nothing here opens a menu that would have nothing to choose from.
   *
   * Enter sends from the keyboard, because a phone keyboard has no modifier to
   * hold; Shift+Enter writes a second line, and Cmd/Ctrl+Enter still sends the
   * way it does on the desktop. The box grows to six lines and stops, so the
   * transcript above it keeps most of the screen.
   */
  interface Props {
    threadId: string
    /** The thread being written into; carried for its state, model and harness. */
    thread?: Thread | null
    /** The project the thread belongs to, named beside the model. */
    project?: Project | null
    /** True while a prompt is waiting to be answered, which the field states. */
    working?: boolean
    /** Called once the service has accepted the prompt, so the page can track it. */
    onqueued: (turn: { prompt: Prompt; body: string }) => void
  }

  let { threadId, thread = null, project = null, working = false, onqueued }: Props = $props()

  let text = $state('')
  let sending = $state(false)
  let error = $state<string | null>(null)
  /**
   * The compose control the app draws once the writing outgrows two lines, and
   * the state it sets. Both follow the text, never a width, so the control
   * appears the moment the third line is written. The rule and the caps come
   * from `$shared/composer-expand`, so the phone and the desktop cannot disagree
   * about when a composer has grown.
   */
  let showExpand = $state(false)
  let expanded = $state(false)

  /** A plain node reference: the box is measured imperatively, never rendered from. */
  let box: HTMLTextAreaElement | null = null

  let canSend = $derived(text.trim().length > 0 && !sending)

  let skin = $derived(statusSkin(thread?.status ?? 'created'))
  let detailTone = $derived(toneColor(skin.tone))

  /** Height follows the content; the stylesheet's cap is what stops the growth,
   *  exactly as the desktop editor's `max-height` does. */
  function fit(): void {
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${box.scrollHeight}px`
  }

  /** The writing row decides two things: its own height, and whether the compose
   *  control exists at all. */
  function handleInput(): void {
    fit()
    if (!box) return
    const lineHeight = parseFloat(getComputedStyle(box).lineHeight) || 21
    const contentHeight = box.scrollHeight - 2
    showExpand = composerShowsExpandControl(
      composerHasThirdLine(contentHeight, lineHeight),
      expanded
    )
  }

  function toggleExpand(): void {
    expanded = !expanded
    if (!box) return
    box.focus()
    const end = box.value.length
    box.setSelectionRange(end, end)
    handleInput()
  }

  /** Keep the element and size it once it is in the document. */
  function attachBox(node: HTMLTextAreaElement): () => void {
    box = node
    fit()
    return () => {
      box = null
    }
  }

  async function send(): Promise<void> {
    const body = text.trim()
    if (body.length === 0 || sending) return
    const clientId = crypto.randomUUID()
    sending = true
    error = null
    try {
      const prompt = await api.sendPrompt(threadId, { body, clientId })
      text = ''
      expanded = false
      await tick()
      handleInput()
      onqueued({ prompt, body })
    } catch (cause) {
      // The text stays in the box so nothing written is lost to a flaky network.
      error = cause instanceof ApiError ? cause.message : 'Cannot reach CodeInOven right now.'
    } finally {
      sending = false
    }
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault()
    void send()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return
    // A phone keyboard sends with its own return key; a second line is asked for.
    if (!event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }
</script>

<form class="composer-box" class:is-expanded={expanded} onsubmit={onSubmit}>
  <div class="composer-field">
    <span class="composer-prompt" aria-hidden="true">&gt;</span>
    <textarea
      {@attach attachBox}
      bind:value={text}
      oninput={handleInput}
      onkeydown={onKeydown}
      rows="1"
      placeholder={working ? 'Queue a message for the oven' : 'Message the oven'}
      aria-label="Message the oven"
      enterkeyhint="send"></textarea>
  </div>

  {#if showExpand}
    <button
      class="composer-expand"
      type="button"
      aria-pressed={expanded}
      aria-label={expanded ? 'Collapse the composer' : 'Expand the composer'}
      title={expanded
        ? 'Collapse the composer to its normal size'
        : 'Expand the composer for a taller typing area'}
      onclick={toggleExpand}
    >
      {#if expanded}
        <CioMinimize size={13} />
      {:else}
        <CioMaximize size={13} />
      {/if}
    </button>
  {/if}

  <div class="composer-foot">
    <span class="composer-meta">
      {#if error}
        <span class="composer-error" title={error}>{error}</span>
      {:else if thread}
        <i class="dot" style:background={detailTone} aria-hidden="true"></i>
        {#if thread.model}
          <span class="composer-chip" title={`Model: ${thread.model}`}>
            <CioCpu size={12} />
            {thread.model}
          </span>
        {/if}
        {#if thread.harness}
          <span class="composer-chip" title={`Harness: ${thread.harness}`}>
            <CioHarness size={12} />
            {thread.harness}
          </span>
        {/if}
        {#if project}
          <span class="composer-where" title={project.name}>{project.name}</span>
        {/if}
      {/if}
    </span>
    <button
      class="send"
      type="submit"
      disabled={!canSend}
      title={working ? 'Queue this message' : 'Send this message'}
      aria-label={working ? 'Queue this message' : 'Send this message'}
    >
      <CioArrowUp size={17} />
    </button>
  </div>
</form>

<style>
  /* The field keeps a gutter on its left, as the app's editor does: the prompt
     marker lives in it, every wrapped line clears it, and the compose control
     sits under the marker without ever covering the writing. */
  .composer-box {
    position: relative;
  }

  .composer-field {
    position: relative;
    display: flex;
    align-items: flex-start;
  }

  .composer-prompt {
    position: absolute;
    top: 0.6875rem;
    left: 0.5rem;
    z-index: 1;
    font-weight: 700;
    line-height: 1.45;
    color: var(--color-accent);
    opacity: 0.55;
    pointer-events: none;
    transition:
      opacity 200ms ease-out,
      transform 200ms ease-out;
  }

  .composer-box:focus-within .composer-prompt {
    opacity: 1;
    transform: translateX(0.125rem);
  }

  .composer-field textarea {
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    padding-left: 1.5rem;
    overflow-y: auto;
  }

  /* The compose control sits in the gutter, under the prompt, clear of the text.
     The same spot the desktop draws it in. */
  .composer-expand {
    position: absolute;
    top: 2.5rem;
    left: 0.375rem;
    display: grid;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--color-dimmed);
    cursor: pointer;
    transition:
      background 120ms ease-out,
      color 120ms ease-out;
  }

  .composer-expand:hover {
    background: var(--color-elevated);
    color: var(--color-foreground);
  }

  .composer-box.is-expanded {
    margin-inline: -0.75rem;
  }

  .composer-error {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--color-danger);
  }

  /* The readings never wrap: the project name is the one part that gives way. */
  .composer-where {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-muted);
  }
</style>
