<script lang="ts">
  import { tick } from 'svelte'
  import CioArrowUp from '@pdslng/cio-icon/CioArrowUp.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioMinimize from '@pdslng/cio-icon/CioMinimize.svelte'
  import Mark from './Mark.svelte'
  import VendorMark from './VendorMark.svelte'
  import { composerHasThirdLine, composerShowsExpandControl } from '#shared/composer-expand'
  import { api, ApiError } from '#lib/api/client'
  import type { Project, Prompt, Thread } from '#lib/api/types'

  /**
   * The composer writes into the thread and states what it is writing into, the
   * same readings the desktop composer carries under its editor: the model, the
   * harness and the project. The service fixes the model and harness per thread,
   * so on a phone they are readings rather than pickers, and nothing here opens a
   * menu that would have nothing to choose from.
   *
   * The keyboard's return key writes a line, exactly as the design's field does:
   * the send plate is the only control that makes a message leave this screen, so
   * a thumb resting on return cannot send half-written thought. Cmd/Ctrl+Enter
   * still sends, the way it does on the desktop. The field grows to the app's
   * rest cap and stops, unless the compose control has grown it, so the
   * transcript above keeps most of the screen.
   */
  interface Props {
    threadId: string
    /** The thread being written into; carried for its model and harness. */
    thread?: Thread | null
    /** The project the thread belongs to, named beside the model. */
    project?: Project | null
    /** True while a prompt is waiting to be answered, which the field states. */
    working?: boolean
    /** Called once the service has accepted the prompt, so the page can track it. */
    onqueued: (turn: { prompt: Prompt; body: string }) => void
    /** The writing itself, owned by the page: a held message that is taken back
     *  to the box arrives as a new draft. */
    draft?: string
    /** Bumped when a draft arrives from outside, so the field can take focus. */
    focusSeq?: number
  }

  let {
    threadId,
    thread = null,
    project = null,
    working = false,
    onqueued,
    draft = $bindable(''),
    focusSeq = 0
  }: Props = $props()
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

  let canSend = $derived(draft.trim().length > 0 && !sending)

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
    // The cap changes with the attribute, so the field is measured once the new
    // one is on it. Measuring before that keeps the expanded height, which is
    // exactly what made collapsing shrink the width and nothing else.
    void tick().then(() => {
      fit()
      handleInput()
    })
  }

  /** A draft handed in from elsewhere (an edited held message) is written and
   *  focused, because the person is expected to carry on in the field. */
  $effect(() => {
    if (focusSeq <= 0) return
    if (!box) return
    box.focus()
    const end = box.value.length
    box.setSelectionRange(end, end)
    fit()
    handleInput()
  })

  /** Keep the element and size it once it is in the document. */
  function attachBox(node: HTMLTextAreaElement): () => void {
    box = node
    fit()
    return () => {
      box = null
    }
  }

  async function send(): Promise<void> {
    const body = draft.trim()
    if (body.length === 0 || sending) return
    const clientId = crypto.randomUUID()
    sending = true
    error = null
    try {
      const prompt = await api.sendPrompt(threadId, { body, clientId })
      draft = ''
      expanded = false
      await tick()
      fit()
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
    // The return key is a line break. Sending is the plate's job alone.
    if (event.key !== 'Enter' || event.shiftKey) return
    if (!event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    void send()
  }
</script>

<form
  class="composer-box"
  data-has-text={draft.trim().length > 0}
  data-expanded={expanded}
  onsubmit={onSubmit}
>
  <div class="composer-field">
    <span class="composer-prompt" aria-hidden="true">&gt;</span>
    <textarea
      {@attach attachBox}
      bind:value={draft}
      oninput={handleInput}
      onkeydown={onKeydown}
      rows="1"
      placeholder={working ? 'Queue a message for the oven' : 'Message the oven'}
      aria-label="Message the oven"
      enterkeyhint="enter"></textarea>
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
      <span class="expand-glyphs" aria-hidden="true">
        <span class="g-max"><CioMaximize size={13} /></span>
        <span class="g-min"><CioMinimize size={13} /></span>
      </span>
    </button>
  {/if}

  <div class="composer-toolbar">
    <span class="toolbar-group">
      {#if error}
        <span class="composer-error" title={error}>{error}</span>
      {:else}
        {#if thread?.model}
          <span class="model-reading" title={`Model: ${thread.model}`}>
            <VendorMark name={thread.model} size={12} />
            <span>{thread.model}</span>
          </span>
        {/if}
        {#if thread?.harness}
          <span class="think-chip" title={`Harness: ${thread.harness}`}>
            <VendorMark name={thread.harness} size={10} />
            {thread.harness}
          </span>
        {/if}
        {#if project}
          <span class="project-reading" title={project.name}>{project.name}</span>
        {/if}
      {/if}
    </span>

    <span class="toolbar-spacer"></span>

    <button
      class="send"
      type="submit"
      disabled={!canSend}
      title={working ? 'Queue this message' : 'Send this message'}
      aria-label={working ? 'Queue this message' : 'Send this message'}
    >
      <CioArrowUp size={15} />
    </button>
  </div>
</form>

<!-- The shoe: the smallest honest statement of what this box writes into, in the
     app's own strip under the composer. -->
{#if project || thread?.model || thread?.harness}
  <div class="composer-shoe">
    <div class="composer-shoe-card">
      {#if project}
        <span class="shoe-seg" title={`Writes into ${project.name}`}>
          <Mark {project} size={14} />
          <span>{project.name}</span>
        </span>
      {/if}
      {#if thread?.model}
        {#if project}<span class="shoe-sep" aria-hidden="true"></span>{/if}
        <span class="shoe-seg" title={`Model: ${thread.model}`}>
          {#if thread.model}<VendorMark name={thread.model} size={11} />{/if}
          <span>{thread.model}</span>
        </span>
      {/if}
      {#if thread?.harness}
        <span class="shoe-sep" aria-hidden="true"></span>
        <span class="shoe-seg" title={`Harness: ${thread.harness}`}>
          <VendorMark name={thread.harness} size={11} />
          <span>{thread.harness}</span>
        </span>
      {/if}
    </div>
  </div>
{/if}
