<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioCheckCheck from '@pdslng/cio-icon/CioCheckCheck.svelte'
  import CioEnter from '@pdslng/cio-icon/CioEnter.svelte'
  import CioShieldAlert from '@pdslng/cio-icon/CioShieldAlert.svelte'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardTag from '../shared/CardTag.svelte'
  import { cardFrameClass } from '../shared/card-frame'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import type { SpeechScope } from '../../../../lib/speech/types'
  import type { PermissionRequest } from '$shared/types'

  interface Props {
    request: PermissionRequest
    onAllowOnce: (requestId: string) => Promise<void>
    onAllowAlways: (requestId: string) => Promise<void>
    onReject: (requestId: string) => Promise<void>
    onAlternative: (requestId: string, alternative: string) => Promise<void>
    scope: SpeechScope
  }

  let { request, onAllowOnce, onAllowAlways, onReject, onAlternative, scope }: Props = $props()

  let folded = $state(false)
  let showingAlternative = $state(false)
  let alternative = $state('')
  let working = $state(false)
  let actionError = $state('')
  let alternativeEditor = $state<RichMarkdownEditor>()
  const alternativeSpeechTargetId = $derived(`permission-alternative-${request.id}`)

  let metadataEntries = $derived(Object.entries(request.metadata))
  let canSubmitAlternative = $derived(alternative.trim().length > 0 && !working)

  function alternativeSpeechTarget() {
    return alternativeEditor?.speechEditorTarget(alternativeSpeechTargetId) ?? null
  }

  function riskTone(
    risk: NonNullable<PermissionRequest['policy']>['risk']
  ): 'ok' | 'info' | 'warn' | 'err' {
    if (risk === 'critical') return 'err'
    if (risk === 'high') return 'warn'
    if (risk === 'medium') return 'info'
    return 'ok'
  }

  function formatMetadata(value: unknown): string {
    if (typeof value === 'string') return value
    if (value === undefined) return 'undefined'
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  function showAlternative(): void {
    showingAlternative = true
  }

  async function allowOnce(): Promise<void> {
    if (working) return
    await runAction(() => onAllowOnce(request.id), 'The permission could not be allowed once.')
  }

  async function allowAlways(): Promise<void> {
    if (working) return
    await runAction(() => onAllowAlways(request.id), 'The permission could not be allowed always.')
  }

  async function reject(): Promise<void> {
    if (working) return
    await runAction(() => onReject(request.id), 'The permission could not be rejected.')
  }

  async function submitAlternative(): Promise<void> {
    const instruction = alternative.trim()
    if (!instruction || working) return
    await runAction(
      () => onAlternative(request.id, instruction),
      'The alternative instruction could not be sent.'
    )
  }

  async function runAction(action: () => Promise<void>, fallback: string): Promise<void> {
    working = true
    actionError = ''
    try {
      await action()
    } catch (error) {
      working = false
      actionError = error instanceof Error ? error.message : fallback
    }
  }
</script>

<section
  out:slide={dismissSlide()}
  class={cardFrameClass('replace', 'overflow-hidden')}
  aria-label="Permission requested"
>
  <!-- The card that takes the composer's place while the agent waits for a
     decision: what it wants to do, the risk it carries, and the three answers. -->
  <CardHead
    icon={CioShieldAlert}
    title="Permission requested"
    chip={{
      text: 'Waiting',
      tone: 'paused',
      title: 'The run is held until this request is answered'
    }}
    foldLabel="permission request"
    bind:folded
  >
    {#snippet meta()}
      {#if request.policy}
        <CardTag text={request.policy.risk} tone={riskTone(request.policy.risk)} />
      {/if}
      <!-- Folded, the header carries what is being asked for, like the task card. -->
      {#if folded}
        <span class="min-w-0 truncate text-[0.6875rem] text-muted">{request.permission}</span>
      {/if}
    {/snippet}
  </CardHead>

  {#if !folded}
    <div transition:slide={foldSlide()}>
      <div class="max-h-80 space-y-4 overflow-y-auto p-4">
        <div>
          <p class="text-sm font-semibold text-foreground">{request.permission}</p>
          {#if request.policy}
            <p class="mt-1 text-xs leading-relaxed text-muted">{request.policy.reason}</p>
          {/if}
        </div>

        {#if request.patterns.length > 0}
          <div>
            <p class="mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-dimmed">
              Requested resources
            </p>
            <div class="space-y-1">
              {#each request.patterns as pattern, index (`${pattern}-${index}`)}
                <p
                  class="break-all bg-elevated px-2.5 py-1.5 font-mono text-[0.6875rem] text-foreground"
                >
                  {pattern}
                </p>
              {/each}
            </div>
          </div>
        {/if}

        {#if request.policy && request.policy.scopedPaths.length > 0}
          <div>
            <p class="mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-dimmed">
              Resolved scope
            </p>
            <div class="space-y-1">
              {#each request.policy.scopedPaths as path, index (`${path}-${index}`)}
                <p class="break-all font-mono text-[0.6875rem] text-muted">{path}</p>
              {/each}
            </div>
          </div>
        {/if}

        {#if metadataEntries.length > 0}
          <div>
            <p class="mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-dimmed">
              Request details
            </p>
            <dl class="space-y-2">
              {#each metadataEntries as [key, value] (key)}
                <div class="grid gap-1">
                  <dt class="text-[0.6875rem] font-semibold text-muted">{key}</dt>
                  <dd
                    class="whitespace-pre-wrap break-all bg-elevated px-2.5 py-1.5 font-mono text-[0.6875rem] text-foreground"
                  >
                    {formatMetadata(value)}
                  </dd>
                </div>
              {/each}
            </dl>
          </div>
        {/if}

        {#if showingAlternative}
          <div>
            <label for={alternativeSpeechTargetId} class="text-xs font-semibold text-foreground">
              Alternative instruction
            </label>
            <div class="mt-1.5 flex items-start gap-2">
              <RichMarkdownEditor
                bind:this={alternativeEditor}
                id={alternativeSpeechTargetId}
                bind:value={alternative}
                autofocus
                disabled={working}
                placeholder="Describe what the agent should do instead…"
                class="w-full resize-y  border bg-app px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-dimmed focus:border-primary disabled:opacity-50"
                containerClass="min-w-0 flex-1"
                ariaLabel="Alternative instruction"
                onSubmit={() => void submitAlternative()}
              />
              <VoiceInputButton
                targetId={alternativeSpeechTargetId}
                getTarget={alternativeSpeechTarget}
                {scope}
                disabled={working}
              />
            </div>
            <p class="mt-1 text-[0.6875rem] text-dimmed">
              The requested action will be rejected and this instruction will steer the current run.
            </p>
          </div>
        {/if}

        {#if actionError}
          <p class="text-xs text-danger" role="alert">{actionError}</p>
        {/if}
      </div>

      <!-- Reject is the only falsy answer. "Provide alternative" steers the run
         instead of refusing it, so it sits on the truthy side attached to "Allow
         always", and the editor's Cancel keeps that slot when it opens. Least
         privilege keeps the primary slot: the least a grant needs is one
         allowance. -->
      <CardFoot>
        {#snippet left()}
          <CardButton
            label="Reject"
            title="Reject this permission"
            variant="ghost-danger"
            disabled={working}
            onclick={() => void reject()}
          />
        {/snippet}
        {#snippet right()}
          {#if showingAlternative}
            <CardButton
              label="Cancel"
              title="Go back to the permission choices"
              variant="secondary"
              disabled={working}
              onclick={() => (showingAlternative = false)}
            />
            <CardButton
              label="Send alternative"
              title="Reject the request and steer the run with this instruction"
              icon={CioEnter}
              variant="primary"
              disabled={!canSubmitAlternative}
              onclick={() => void submitAlternative()}
            />
          {:else}
            <CardButton
              label="Provide alternative"
              title="Provide an alternative instead"
              variant="secondary"
              disabled={working}
              onclick={showAlternative}
            />
            <CardButton
              label="Allow always"
              title="Allow this kind of request always"
              icon={CioCheckCheck}
              variant="secondary"
              disabled={working}
              onclick={() => void allowAlways()}
            />
            <CardButton
              label="Allow once"
              title="Allow this request once"
              icon={CioCheck}
              variant="primary"
              disabled={working}
              onclick={() => void allowOnce()}
            />
          {/if}
        {/snippet}
      </CardFoot>
    </div>
  {/if}
</section>
