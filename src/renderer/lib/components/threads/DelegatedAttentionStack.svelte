<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import type { DelegatedAttentionEntry } from '$shared/delegated-attention'
  import type {
    AgentEvent,
    AgentSecretDraft,
    AgentSecretSubmission,
    PermissionReply,
    Thread
  } from '$shared/types'
  import type { SpeechScope } from '$shared/speech/types'
  import { AssistantDefaultIcon, getAssistantIcon } from '$lib/assistant-icons'
  import { getProjectIcon } from '$lib/project-icons'
  import { assistants } from '$lib/stores/assistants.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { openThreadById } from '$lib/threads/open-thread-by-id'
  import ThreadMessageSpeaker from './ThreadMessageSpeaker.svelte'
  import AgentQuestionCard from './AgentQuestionCard.svelte'
  import AgentSecretCard from './AgentSecretCard.svelte'
  import PermissionRequestCard from './PermissionRequestCard.svelte'
  import DelegatedRetryNotice from './DelegatedRetryNotice.svelte'
  import { isThreadRequestEvent } from './delegated-attention-events'

  interface Props {
    /** The conversation the user has open: the root of whatever was dispatched. */
    projectId: string
    threadId: string
  }

  let { projectId, threadId }: Props = $props()

  /**
   * What the threads dispatched from this conversation are doing, as replies.
   *
   * Each entry is drawn exactly where the assistant or project would have
   * answered: its own mark, its own name, the thread it belongs to, and then the
   * card. The card is the child thread's own request, not a copy, so every action
   * below submits against `entry.projectId`/`entry.threadId` and settles the
   * blocked thread directly, whether the user answers here or there.
   *
   * That is what makes the conversation read as a group: several threads can hold
   * the floor at once, and one of them stopping for a decision never waits for the
   * conversation to be free.
   */
  let entries = $state<DelegatedAttentionEntry[]>([])

  async function refresh(): Promise<void> {
    try {
      entries = await invoke('agent:listDelegatedAttention', projectId, threadId)
    } catch {
      // A failed read leaves the rows already on screen: the thread that raised
      // them is blocked either way, and its own card still answers it.
    }
  }

  /** Drop one settled request, so the row goes as soon as the decision lands. */
  function drop(requestId: string): void {
    entries = entries.filter((entry) => entry.requestId !== requestId)
  }

  function scopeFor(entry: DelegatedAttentionEntry): SpeechScope {
    return { kind: 'project', projectId: entry.projectId, threadId: entry.threadId }
  }

  /** The speaker of one row: the assistant the thread works as, else its project. */
  function speakerOf(entry: DelegatedAttentionEntry): {
    name: string
    icon: string | null
    color: string | undefined
  } {
    const assistant = entry.assistantId
      ? (assistants.assistants.find((candidate) => candidate.id === entry.assistantId) ?? null)
      : null
    if (assistant) {
      return {
        name: assistant.name,
        icon: getAssistantIcon(assistant, assistants.iconUrls.get(assistant.id) ?? null),
        color: assistant.color
      }
    }
    const project = scopeState.projects.find((candidate) => candidate.id === entry.projectId)
    if (project) {
      return {
        name: project.name,
        icon: getProjectIcon(project, project.iconUrl ?? undefined),
        color: project.color
      }
    }
    return { name: entry.threadTitle, icon: null, color: undefined }
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

  /** Persist one entry's draft, so a half-filled card resumes where it was. */
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
    const unsubscribes = [
      // A request appears and settles on the child thread's session, which this
      // conversation never receives as its own event, so the app-wide stream is
      // watched and every relevant one re-reads the authoritative list.
      subscribe('agent:event', (...args: unknown[]) => {
        const event = args[0] as AgentEvent | undefined
        if (event && isThreadRequestEvent(event)) void refresh()
      }),
      // A dispatched thread's own row changes when it parks on a provider wait or
      // resumes, and that is the only signal a retry notice has: the row says who
      // dispatched it, so the update is enough to know whether this is our row.
      subscribe('thread:updated', (...args: unknown[]) => {
        const thread = args[0] as Thread | undefined
        if (!thread) return
        const dispatchedHere = thread.dispatchOrigin?.initiatorThreadId === threadId
        const alreadyShown = entries.some((entry) => entry.threadId === thread.id)
        if (dispatchedHere || alreadyShown) void refresh()
      })
    ]
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  })
</script>

{#if entries.length > 0}
  <div class="space-y-3">
    {#each entries as entry (entry.requestId)}
      {@const speaker = speakerOf(entry)}
      <div
        class="message-block min-w-0 max-w-[90%] border border-border bg-surface px-3.5 py-2.5 text-[0.8125rem] text-foreground"
        data-delegated-attention={entry.kind}
      >
        <!-- The speaker is a door: clicking the mark or the name opens the thread
             this reply came from, so an answer read here can be followed to the
             work itself. The thread tag below stays with the card. -->
        <button
          type="button"
          class="mb-1.5 flex max-w-full min-w-0 items-center text-left"
          title={`Open ${entry.threadTitle}`}
          aria-label={`Open ${entry.threadTitle}`}
          onclick={() => void openThreadById(entry.projectId, entry.threadId)}
        >
          <ThreadMessageSpeaker name={speaker.name} icon={speaker.icon} color={speaker.color} />
        </button>
        <!-- Which conversation this reply comes from: the row above names who is
             speaking, and this names the work, exactly like a thread tag. -->
        <div class="mb-2 flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-dimmed">
          {#if speaker.icon}
            <img
              src={speaker.icon}
              alt=""
              class="h-3 w-3 shrink-0 object-contain"
              draggable="false"
            />
          {:else if entry.assistantId}
            <AssistantDefaultIcon size={11} class="shrink-0" />
          {/if}
          <span class="truncate">{entry.threadTitle}</span>
        </div>
        {#if entry.kind === 'retry' && entry.retry}
          <DelegatedRetryNotice retry={entry.retry} />
        {:else if entry.kind === 'permission' && entry.permission}
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
