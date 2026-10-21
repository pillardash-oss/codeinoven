<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { PendingAgentQuestionRequest } from '$shared/types'
  import AgentQuestionCard from '../threads/AgentQuestionCard.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'

  interface Props {
    projectId: string
    threadId: string
    repeated: boolean
    onDone: () => void
    onContinue: () => void
    onDismiss: () => void
  }

  let { projectId, threadId, repeated, onDone, onContinue, onDismiss }: Props = $props()
  let request = $state<PendingAgentQuestionRequest | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false

  function settle(action: () => void): void {
    if (settled) return
    settled = true
    clearTimeout(timer)
    action()
  }

  onMount(() => {
    let alive = true
    void invoke('config:get')
      .then((config) => {
        if (!alive || settled) return
        const createdAt = Date.now()
        request = {
          projectId,
          threadId,
          requestId: `assistant-session-${threadId}`,
          sessionId: threadId,
          createdAt,
          activeQuestionIndex: 0,
          answers: [[]],
          interactedQuestionIndexes: [],
          expiresAt: createdAt + config.questionTimeoutMs,
          questions: [
            {
              header: 'Finish modifications',
              prompt: repeated
                ? 'I need your confirmation to conclude this session. Are you done with the modifications? Should I mark this session as done?'
                : 'Are you done with the modifications? Should I mark this session as done?',
              custom: false,
              richOptions: [
                {
                  label: 'Yes',
                  description: 'Mark this modification session as done.',
                  recommended: true
                },
                { label: 'No', description: 'Continue modifying assistant behavior.' }
              ]
            }
          ]
        }
        timer = setTimeout(() => settle(onDone), config.questionTimeoutMs)
      })
      .catch(() => {
        // Without a deadline, leave the editor available rather than trapping it behind a card.
        if (alive) settle(onContinue)
      })
    return () => {
      alive = false
      clearTimeout(timer)
    }
  })
</script>

<svelte:window
  onkeydown={(event) => {
    if (
      request &&
      !event.defaultPrevented &&
      keymapState.matches('assistant-setup-primary-action', event)
    ) {
      event.preventDefault()
      settle(request.answers[0]?.[0] === 'No' ? onContinue : onDone)
    }
  }}
/>

{#if request}
  <AgentQuestionCard
    {request}
    scope={{ kind: 'project', projectId, threadId }}
    onAnswer={async (_requestId, answers) => {
      settle(answers[0]?.[0] === 'Yes' ? onDone : onContinue)
    }}
    onDismiss={async () => settle(onDismiss)}
    onUpdate={async (_requestId, questionIndex, answers) => {
      if (!request || settled) return null
      clearTimeout(timer)
      request = {
        ...request,
        answers: request.answers.map((entry, index) => (index === questionIndex ? answers : entry)),
        interactedQuestionIndexes: [questionIndex],
        expiresAt: undefined
      }
      return request
    }}
  />
{/if}
