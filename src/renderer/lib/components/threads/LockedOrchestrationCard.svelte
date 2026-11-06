<script lang="ts">
  import CioArrowRight from '@pdslng/cio-icon/CioArrowRight.svelte'
  import CioLock from '@pdslng/cio-icon/CioLock.svelte'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import { foldSlide } from '../shared/card-motion'
  import { threadCardFold } from '$lib/stores/thread-card-fold.svelte'

  interface Props {
    /** Which coordinated thread this is, so the card explains the way out that
     *  actually exists for it. */
    kind: 'worker' | 'auditor' | 'pawn'
    threadId: string
    coordinatorTitle?: string
    /** Another card sits directly above this one, so its top rule is the broken
     *  line that separates two stacked surfaces. */
    stackedAbove?: boolean
    /** The surface below carries the join, so this card drops its bottom rule. */
    joinsBelow?: boolean
    onOpenCoordinator: () => void
  }

  let {
    kind,
    threadId,
    coordinatorTitle,
    stackedAbove = false,
    joinsBelow = false,
    onOpenCoordinator
  }: Props = $props()

  const foldState = {
    get folded(): boolean {
      return threadCardFold.isFolded(threadId, 'locked-orchestration')
    },
    set folded(value: boolean) {
      threadCardFold.setFolded(threadId, 'locked-orchestration', value)
    }
  }

  const subject = $derived(
    kind === 'auditor' ? 'auditor' : kind === 'pawn' ? 'helper agent' : 'worker'
  )
  const owner = $derived(coordinatorTitle ? `“${coordinatorTitle}”` : 'its coordinator')
</script>

<!-- A coordinated thread takes no separate conversation, so it must not offer a
composer that only collects a rejected message. This card is what the composer's
slot becomes: the reason, and the one control that actually moves the work on. -->
<CardFrame placement="replace" label="Coordinated thread" {stackedAbove} {joinsBelow}>
  <CardHead
    icon={CioLock}
    title="Driven by its coordinator"
    chip={{ text: 'Locked', tone: 'paused' }}
    bind:folded={foldState.folded}
    foldLabel="coordinated thread"
  />

  {#if !foldState.folded}
    <div
      transition:slide={foldSlide()}
      class="flex flex-col gap-1.5 px-3 py-2.5 text-xs leading-relaxed text-muted"
    >
      {#if kind === 'auditor'}
        <p>
          This thread is the {subject} that {owner} runs. Its audit is started, retried and re-checked
          from that thread's audit card, and the auditor's model and account are chosen there too.
        </p>
        <p>
          Nothing is typed into this thread: a message here would start a second run beside the
          audit the coordinator is driving.
        </p>
      {:else if kind === 'pawn'}
        <p>
          This thread is a {subject} its parent agent spawns and steers. It reports to that agent, which
          is where a new instruction goes.
        </p>
      {:else}
        <p>
          This thread is a {subject} of {owner}. It takes its instructions there, and while it is
          running you can still message it here to steer the work in progress.
        </p>
        <p>
          Once it finishes, the next instruction belongs to the coordinator so the task's evidence
          and review stay in one place.
        </p>
      {/if}
    </div>
  {/if}

  {#if !foldState.folded}
    <CardFoot>
      {#snippet right()}
        <CardButton
          label="Open coordinator"
          title={coordinatorTitle
            ? `Open the coordinator thread “${coordinatorTitle}”`
            : 'Open the coordinator that runs this thread'}
          icon={CioArrowRight}
          variant="primary"
          onclick={onOpenCoordinator}
        />
      {/snippet}
    </CardFoot>
  {/if}
</CardFrame>
