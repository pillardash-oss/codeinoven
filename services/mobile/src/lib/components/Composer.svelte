<script lang="ts">
  import { tick } from 'svelte'
  import CioArrowUp from '@pdslng/cio-icon/CioArrowUp.svelte'
  import CioCpu from '@pdslng/cio-icon/CioCpu.svelte'
  import CioHarness from '@pdslng/cio-icon/CioHarness.svelte'
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
  /** A plain node reference: the box is measured imperatively, never rendered from. */
  let box: HTMLTextAreaElement | null = null

  let canSend = $derived(text.trim().length > 0 && !sending)

  let skin = $derived(statusSkin(thread?.status ?? 'created'))
  let detailTone = $derived(toneColor(skin.tone))

  /** Height follows the content; the sheet's max-height is what caps the growth. */
  function fit(): void {
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${box.scrollHeight}px`
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
      await tick()
      fit()
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

<form class="composer-box" onsubmit={onSubmit}>
  <textarea
    {@attach attachBox}
    bind:value={text}
    oninput={fit}
    onkeydown={onKeydown}
    rows="1"
    placeholder={working ? 'Queue a message for the oven' : 'Message the oven'}
    aria-label="Message the oven"
    enterkeyhint="send"></textarea>

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
  /* Six lines at the app's 0.9375rem/1.45 setting, plus the box's padding. */
  .composer-box textarea {
    max-height: 9.5rem;
    overflow-y: auto;
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
