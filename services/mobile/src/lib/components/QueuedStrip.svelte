<script lang="ts">
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import Sheet from './Sheet.svelte'
  import { api, ApiError } from '#lib/api/client'
  import type { Prompt } from '#lib/api/types'

  /**
   * The messages waiting behind the running turn, held on the composer's top edge
   * rather than raised as second bubbles in the transcript: they are what the box
   * below them is for.
   *
   * The strip folds from its own head, and the body is the whole of what a held
   * message can still do: read it, take it back to the box, delete it, or send it
   * now as a steer so the oven takes it before the rest of the queue. Those three
   * are the service's own verbs; nothing here pretends to a fourth.
   */
  interface Props {
    prompts: Prompt[]
    /** The prompt is gone: the page drops its row. */
    onremoved: (id: string) => void
    /** The prompt went back into the composer, which owns the writing. */
    onedited: (body: string, id: string) => void
    /** The oven will take this prompt next, ahead of the queue. */
    onsteered: (prompt: Prompt) => void
  }

  let { prompts, onremoved, onedited, onsteered }: Props = $props()

  let open = $state(false)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let confirming = $state<Prompt | null>(null)

  /** Only a prompt that has not been sent next is still waiting: one that was
   *  steered is the oven's to take, and counting it would misstate the queue. */
  let waiting = $derived(prompts.filter((prompt) => prompt.state === 'queued').length)
  let label = $derived(
    waiting === 0 ? 'Steering' : waiting === 1 ? '1 waiting' : `${waiting} waiting`
  )
  let head = $derived(prompts[0]?.body ?? '')

  function stateLabel(prompt: Prompt): string {
    if (prompt.state === 'steering') return 'Sent now, the oven takes it next'
    if (prompt.state === 'claimed') return 'The oven is answering it'
    if (prompt.state === 'failed') return prompt.error ?? 'The oven could not take it'
    return 'Waiting its turn'
  }

  async function act(run: () => Promise<void>): Promise<void> {
    if (busy) return
    busy = true
    error = null
    try {
      await run()
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : 'Cannot reach CodeInOven right now.'
    } finally {
      busy = false
    }
  }

  function steer(prompt: Prompt): Promise<void> {
    return act(async () => {
      onsteered(await api.steerPrompt(prompt.id))
    })
  }

  function edit(prompt: Prompt): Promise<void> {
    return act(async () => {
      await api.deletePrompt(prompt.id)
      onedited(prompt.body, prompt.id)
    })
  }

  function remove(prompt: Prompt): Promise<void> {
    return act(async () => {
      await api.deletePrompt(prompt.id)
      confirming = null
      onremoved(prompt.id)
    })
  }
</script>

<div class="queue-wrap">
  <button
    class="queue"
    type="button"
    aria-expanded={open}
    aria-controls="queued-messages"
    aria-label={open ? 'Fold the waiting messages' : 'Show the waiting messages'}
    title={open ? 'Fold the waiting messages' : 'Show the waiting messages'}
    onclick={() => (open = !open)}
  >
    <span class="lead">
      <b>{label}</b>
      <span>{head}</span>
    </span>
    <CioChevronDown size={14} />
  </button>

  {#if open}
    <div class="queue-body" id="queued-messages">
      {#if error}
        <p class="queue-error">{error}</p>
      {/if}

      {#each prompts as prompt (prompt.id)}
        <div class="queued-item">
          <p>{prompt.body}</p>

          {#if prompt.state === 'queued'}
            <div class="queue-acts">
              <button
                class="btn quiet"
                type="button"
                disabled={busy}
                onclick={() => (confirming = prompt)}
              >
                Delete
              </button>
              <span class="right">
                <button class="btn" type="button" disabled={busy} onclick={() => edit(prompt)}>
                  Edit
                </button>
                <button
                  class="btn primary"
                  type="button"
                  disabled={busy}
                  onclick={() => steer(prompt)}
                >
                  Send now
                </button>
              </span>
            </div>
          {:else}
            <p class="queue-state">{stateLabel(prompt)}</p>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<Sheet
  open={confirming !== null}
  onclose={() => (confirming = null)}
  placement="bottom"
  label="Delete the waiting message"
>
  <div class="sheet-form">
    <div class="sheet-grab"></div>
    <div class="sheet-head">
      <h2>Delete this message?</h2>
    </div>
    <p class="sheet-note">
      It has not been sent yet, so deleting it takes it out of the queue for good.
    </p>
    <div class="sheet-foot">
      <button class="btn quiet" type="button" onclick={() => (confirming = null)}>Cancel</button>
      <button
        class="btn danger"
        type="button"
        disabled={busy}
        onclick={() => confirming && remove(confirming)}
      >
        Delete
      </button>
    </div>
  </div>
</Sheet>
