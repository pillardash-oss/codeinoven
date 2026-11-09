<script lang="ts">
  import { onMount } from 'svelte'
  import { slide } from 'svelte/transition'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import type { DelegatedAttentionEntry } from '$shared/delegated-attention'
  import type {
    AgentEvent,
    AgentSecretDraft,
    AgentSecretSubmission,
    PermissionReply
  } from '$shared/types'
  import type { SpeechScope } from '$shared/speech/types'
  import AgentQuestionCard from './AgentQuestionCard.svelte'
  import AgentSecretCard from './AgentSecretCard.svelte'
  import PermissionRequestCard from './PermissionRequestCard.svelte'
  import DelegatedThreadBadge from './DelegatedThreadBadge.svelte'
  import { isThreadRequestEvent } from './delegated-attention-events'

  interface Props {
    /** The conversation the user has open: the root of whatever was dispatched. */
    projectId: string
    threadId: string
  }

  let { projectId, threadId }: Props = $props()

  /**
   * The cards the threads dispatched from this conversation are waiting on.
   *
   * They are the child thread's own requests, not copies: every action below
   * submits against `entry.projectId`/`entry.threadId`, so answering here settles
   * the blocked thread exactly as answering it there does. That is the whole point
   * of the mirror: one request, two places to decide it, and no agent relaying what
   * the user said.
   */
  let entries = $state<DelegatedAttentionEntry[]>([])

  async function refresh(): Promise<void> {
    try {
      entries = await invoke('agent:listDelegatedAttention', projectId, threadId)
    } catch {
      // A failed read leaves the cards that are already on screen: the thread that
      // raised them is blocked either way, and its own card still answers it.
    }
  }

  /** Drop one settled request from the stack, without waiting for the next read. */
  function drop(requestId: string): void {
    entries = entries.filter((entry) => entry.requestId !== requestId)
  }

  function scopeFor(entry: DelegatedAttentionEntry): SpeechScope {
    return { kind: 'project', projectId: entry.projectId, threadId: entry.threadId }
  }

  async function answerQuestion(
    entry: DelegatedAttentionEntry,
    requestId: string,
    answers: string[][]
  ): Promise<void> {
    await invoke('agent:answerQuestion', entry.projectId, entry.threadId, requestId, answers)
    drop(requestId)
  }

  async function dismissQuestion(entry: DelegatedAttentionEntry, requestId: string): Promise<void> {
    await invoke('agent:dismissQuestion', entry.projectId, entry.threadId, requestId)
    drop(requestId)
  }

  async function updateQuestion(
    entry: DelegatedAttentionEntry,
    requestId: string,
    questionIndex: number,
    answers: string[],
    nextQuestionIndex?: number
  ) {
    return invoke(
      'agent:updateQuestion',
      entry.projectId,
      entry.threadId,
      requestId,
      questionIndex,
      answers,
      nextQuestionIndex
    )
  }

  async function submitSecrets(
    entry: DelegatedAttentionEntry,
    requestId: string,
    secrets: AgentSecretSubmission[]
  ): Promise<void> {
    await invoke('agent:answerSecret', entry.projectId, entry.threadId, requestId, secrets)
    drop(requestId)
  }

  /** Persist one entry's draft, so a card left half filled resumes where it was. */
  async function draftSecret(
    entry: DelegatedAttentionEntry,
    requestId: string,
    questionIndex: number,
    draft: AgentSecretDraft,
    nextQuestionIndex?: number
  ): Promise<void> {
    await invoke(
      'agent:updateSecretDraft',
      entry.projectId,
      entry.threadId,
      requestId,
      questionIndex,
      draft,
      nextQuestionIndex
    ).catch(() => undefined)
  }

  /** Hold a secret card's countdown while the user works on it. */
  async function pauseSecret(
    entry: DelegatedAttentionEntry,
    requestId: string,
    questionIndex: number
  ): Promise<void> {
    await invoke(
      'agent:updateQuestion',
      entry.projectId,
      entry.threadId,
      requestId,
      questionIndex,
      []
    )
  }

  async function replyPermission(
    entry: DelegatedAttentionEntry,
    reply: PermissionReply,
    alternative?: string
  ): Promise<void> {
    await invoke('agent:replyPermission', entry.projectId, entry.requestId, reply, alternative)
    drop(entry.requestId)
  }

  onMount(() => {
    void refresh()
    // A request appears and settles on the child thread's session, which this
    // conversation never receives as its own event, so the stream is watched for
    // the whole app and every relevant one re-reads the authoritative list.
    return subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as AgentEvent | undefined
      if (event && isThreadRequestEvent(event)) void refresh()
    })
  })
</script>

{#if entries.length > 0}
  <div class="space-y-2">
    {#each entries as entry (entry.requestId)}
      <div class="space-y-1.5" in:slide={{ duration: 0 }}>
        <DelegatedThreadBadge
          projectId={entry.projectId}
          threadTitle={entry.threadTitle}
          assistantId={entry.assistantId}
        />
        {#if entry.kind === 'permission' && entry.permission}
          {#key entry.requestId}
            <PermissionRequestCard
              request={entry.permission}
              scope={scopeFor(entry)}
              onAllowOnce={() => replyPermission(entry, 'once')}
              onAllowAlways={() => replyPermission(entry, 'always')}
              onReject={() => replyPermission(entry, 'reject')}
              onAlternative={(_requestId, alternative) =>
                replyPermission(entry, 'reject', alternative)}
            />
          {/key}
        {:else if entry.question}
          {#key entry.requestId}
            {#if entry.kind === 'secret'}
              <AgentSecretCard
                request={entry.question}
                scope={scopeFor(entry)}
                onSubmit={(requestId, secrets) => submitSecrets(entry, requestId, secrets)}
                onDismiss={(requestId) => dismissQuestion(entry, requestId)}
                onPause={(requestId, questionIndex) => pauseSecret(entry, requestId, questionIndex)}
                onDraft={(requestId, questionIndex, draft, next) =>
                  draftSecret(entry, requestId, questionIndex, draft, next)}
              />
            {:else}
              <AgentQuestionCard
                request={entry.question}
                scope={scopeFor(entry)}
                onAnswer={(requestId, answers) => answerQuestion(entry, requestId, answers)}
                onDismiss={(requestId) => dismissQuestion(entry, requestId)}
                onUpdate={(requestId, questionIndex, answers, next) =>
                  updateQuestion(entry, requestId, questionIndex, answers, next)}
              />
            {/if}
          {/key}
        {/if}
      </div>
    {/each}
  </div>
{/if}
