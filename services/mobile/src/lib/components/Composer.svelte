<script lang="ts">
  import { tick } from 'svelte'
  import CioSend from '@pdslng/cio-icon/CioSend.svelte'
  import { api, ApiError } from '#lib/api/client'
  import { statusSkin, toneColor } from '#lib/api/status'
  import type { Project, Thread } from '#lib/api/types'

  /**
   * The composer is the only place a phone writes to the Oven. It grows to six
   * lines and stops there, so the transcript above it keeps most of the screen.
   * Cmd+Enter and Ctrl+Enter send, because that is the app's primary action
   * key; a plain Enter inserts a newline, because a touch keyboard has no
   * modifier to press and a half written prompt must not leave the box.
   *
   * Under the box it states what the message is being written into, the same
   * reading the desktop composer's shoe gives: the thread's own state and the
   * model and harness that will answer it.
   */
  interface Props {
    threadId: string
    /** The thread being written into; carried for its state, model and harness. */
    thread?: Thread | null
    /** The project the thread belongs to, used when the thread names no model. */
    project?: Project | null
    /** Called once the service has accepted the prompt, so the page can queue it. */
    onqueued: (turn: { clientId: string; body: string }) => void
  }

  let { threadId, thread = null, project = null, onqueued }: Props = $props()

  let text = $state('')
  let sending = $state(false)
  let error = $state<string | null>(null)
  /** A plain node reference: the box is measured imperatively, never rendered from. */
  let box: HTMLTextAreaElement | null = null

  let canSend = $derived(text.trim().length > 0 && !sending)

  let skin = $derived(statusSkin(thread?.status ?? 'created'))
  let detailTone = $derived(toneColor(skin.tone))
  /**
   * Model and harness name what answers, which is what the desktop states too.
   * A thread whose service payload carries neither still says where it lives
   * rather than leaving the line empty.
   */
  let detailLabel = $derived.by(() => {
    const parts = [thread?.model, thread?.harness].filter(
      (part): part is string => typeof part === 'string' && part.length > 0
    )
    if (parts.length > 0) return parts.join(' · ')
    return project?.name ?? skin.label
  })

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
      await api.sendPrompt(threadId, { body, clientId })
      text = ''
      await tick()
      fit()
      onqueued({ clientId, body })
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
    if (!event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    void send()
  }
</script>

<form class="composer-box" onsubmit={onSubmit}>
  <textarea
    {@attach attachBox}
    bind:value={text}
    oninput={fit}
    onkeydown={onKeydown}
    rows="1"
    placeholder="Message the oven"
    aria-label="Message the oven"
    enterkeyhint="enter"></textarea>

  <div class="composer-foot">
    <span class="composer-meta">
      {#if error}
        <span class="composer-error" title={error}>{error}</span>
      {:else if thread}
        <i class="dot" style:background={detailTone} aria-hidden="true"></i>
        <span class="composer-where" title={detailLabel}>{detailLabel}</span>
      {/if}
    </span>
    <button
      class="send"
      type="submit"
      disabled={!canSend}
      title="Send prompt"
      aria-label="Send prompt"
    >
      <CioSend size={18} />
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

  /* The model and harness line stays one line: a long model name is cut, never
     wrapped into a second row under the box. */
  .composer-where {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-muted);
  }

  .send:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
