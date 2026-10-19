<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardButton from '../shared/CardButton.svelte'
  import { threadCardFold } from '$lib/stores/thread-card-fold.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'

  interface Props {
    threadId: string
    active?: boolean
    onModify: () => void
    onStartTask: () => void
  }

  let { threadId, active = true, onModify, onStartTask }: Props = $props()
  const fold = {
    get folded(): boolean {
      return threadCardFold.isFolded(threadId, 'assistant-ready')
    },
    set folded(value: boolean) {
      threadCardFold.setFolded(threadId, 'assistant-ready', value)
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (
      active &&
      !event.defaultPrevented &&
      keymapState.matches('assistant-setup-primary-action', event)
    ) {
      event.preventDefault()
      onStartTask()
    }
  }}
/>

<CardFrame placement="replace" label="Assistant setup complete">
  <CardHead
    icon={CioCheck}
    title="Assistant has learned how to work for you"
    chip={{ text: 'Ready', tone: 'paused' }}
    bind:folded={fold.folded}
    foldLabel="assistant setup complete"
  />
  {#if !fold.folded}
    <p class="px-3 py-3 text-xs text-muted">
      Do you want to make any changes, or do you want to start a task?
    </p>
    <CardFoot>
      {#snippet left()}
        <CardButton label="Modify assistant behavior" onclick={onModify} />
      {/snippet}
      {#snippet right()}
        <CardButton label="Start a task" variant="primary" onclick={onStartTask} />
      {/snippet}
    </CardFoot>
  {/if}
</CardFrame>
