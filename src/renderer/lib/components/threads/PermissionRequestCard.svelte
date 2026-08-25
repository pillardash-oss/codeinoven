<script lang="ts">
  import { Check, CheckCheck, CornerDownRight, ShieldAlert, X } from '@lucide/svelte'
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

  function riskClass(risk: NonNullable<PermissionRequest['policy']>['risk']): string {
    if (risk === 'critical') return 'bg-danger/10 text-danger'
    if (risk === 'high') return 'bg-warning/15 text-warning'
    if (risk === 'medium') return 'bg-info/10 text-info'
    return 'bg-success/10 text-success'
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
  class="overflow-hidden rounded-xl border border-warning/30 bg-surface shadow-sm"
  aria-label="Permission requested"
>
  <div class="flex items-center justify-between gap-3 border-b px-4 py-2.5">
    <div class="flex min-w-0 items-center gap-2">
      <ShieldAlert size={15} class="shrink-0 text-warning" />
      <p class="truncate text-xs font-semibold uppercase tracking-wide text-muted">
        Permission requested
      </p>
      {#if request.policy}
        <span
          class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase {riskClass(
            request.policy.risk
          )}"
        >
          {request.policy.risk}
        </span>
      {/if}
    </div>
    <button
      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-30"
      disabled={working}
      onclick={() => void reject()}
      aria-label="Reject and close permission request"
      title="Reject and close"
    >
      <X size={15} />
    </button>
  </div>

  <div class="max-h-80 space-y-4 overflow-y-auto p-4">
    <div>
      <p class="text-sm font-semibold text-foreground">{request.permission}</p>
      {#if request.policy}
        <p class="mt-1 text-xs leading-relaxed text-muted">{request.policy.reason}</p>
      {/if}
    </div>

    {#if request.patterns.length > 0}
      <div>
        <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-dimmed">
          Requested resources
        </p>
        <div class="space-y-1">
          {#each request.patterns as pattern, index (`${pattern}-${index}`)}
            <p
              class="break-all rounded-lg bg-elevated px-2.5 py-1.5 font-mono text-[11px] text-foreground"
            >
              {pattern}
            </p>
          {/each}
        </div>
      </div>
    {/if}

    {#if request.policy && request.policy.scopedPaths.length > 0}
      <div>
        <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-dimmed">
          Resolved scope
        </p>
        <div class="space-y-1">
          {#each request.policy.scopedPaths as path, index (`${path}-${index}`)}
            <p class="break-all font-mono text-[11px] text-muted">{path}</p>
          {/each}
        </div>
      </div>
    {/if}

    {#if metadataEntries.length > 0}
      <div>
        <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-dimmed">
          Request details
        </p>
        <dl class="space-y-2">
          {#each metadataEntries as [key, value] (key)}
            <div class="grid gap-1">
              <dt class="text-[11px] font-semibold text-muted">{key}</dt>
              <dd
                class="whitespace-pre-wrap break-all rounded-lg bg-elevated px-2.5 py-1.5 font-mono text-[11px] text-foreground"
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
            class="w-full resize-y rounded-lg border bg-app px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-dimmed focus:border-primary disabled:opacity-50"
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
        <p class="mt-1 text-[11px] text-dimmed">
          The requested action will be rejected and this instruction will steer the current run.
        </p>
      </div>
    {/if}

    {#if actionError}
      <p class="text-xs text-danger" role="alert">{actionError}</p>
    {/if}
  </div>

  <div class="flex items-center justify-between gap-2 border-t px-4 py-2.5">
    <button
      class="min-h-8 rounded-lg px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
      disabled={working}
      onclick={() => void reject()}
    >
      Reject
    </button>
    <div class="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
      {#if showingAlternative}
        <button
          class="min-h-8 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-overlay disabled:opacity-40"
          disabled={working}
          onclick={() => (showingAlternative = false)}
        >
          Cancel
        </button>
        <button
          class="flex min-h-8 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-40"
          disabled={!canSubmitAlternative}
          onclick={() => void submitAlternative()}
        >
          Send alternative
          <CornerDownRight size={13} />
        </button>
      {:else}
        <button
          class="flex min-h-8 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-40"
          disabled={working}
          onclick={() => void allowOnce()}
        >
          Allow once
          <Check size={13} />
        </button>
        <button
          class="flex min-h-8 items-center gap-1.5 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-overlay disabled:opacity-40"
          disabled={working}
          onclick={() => void allowAlways()}
        >
          Allow always
          <CheckCheck size={13} />
        </button>
        <button
          class="min-h-8 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-overlay disabled:opacity-40"
          disabled={working}
          onclick={() => void showAlternative()}
        >
          Provide alternative
        </button>
      {/if}
    </div>
  </div>
</section>
