<script lang="ts">
  import type { UtilitySetupReport } from '$shared/types'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'

  interface Props {
    editorError: string
    agentReport: UtilitySetupReport | null
    agentRequest: string
    saving: boolean
  }

  let { editorError, agentReport, agentRequest = $bindable(), saving }: Props = $props()
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if editorError}
    <p class="mx-6 mt-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {editorError}
    </p>
  {/if}
  {#if agentReport}
    <div class="min-h-0 flex-1 overflow-y-auto p-6">
      <p class="text-sm font-semibold">Installed</p>
      <div class="mt-2 flex flex-wrap gap-1.5">
        {#each agentReport.installed as utility (utility.id)}
          <span class="rounded-md bg-raised px-2 py-1 text-[0.6875rem] font-medium">
            {utility.name} · {utility.kind}
          </span>
        {/each}
      </div>
      {#if agentReport.summary}
        <p class="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-muted">
          {agentReport.summary}
        </p>
      {/if}
    </div>
  {:else}
    <RichMarkdownEditor
      id="agent-utility-setup-request"
      bind:value={agentRequest}
      placeholder="Set up the official Svelte MCP for Codex and Claude Code globally, or create a deployment skill for this project…"
      ariaLabel="Agent utility setup request"
      disabled={saving}
      containerClass="min-h-0 flex-1"
      class="h-full w-full overflow-y-auto px-3.5 pb-1 pt-3 text-sm leading-5 text-foreground outline-none"
    />
  {/if}
</div>
