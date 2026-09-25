<script lang="ts">
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import { skillPlaceholder, type UtilityDraft } from './utility-editor-modal-helpers'

  interface Props {
    draft: UtilityDraft
    isNative: boolean
  }

  let { draft = $bindable(), isNative }: Props = $props()
</script>

<fieldset class="space-y-3 rounded-xl border p-3">
  <legend class="px-1 text-xs font-semibold">
    {draft.kind === 'skill'
      ? 'SKILL.md'
      : draft.kind === 'mcp'
        ? 'MCP connection'
        : draft.kind === 'web_search' || draft.kind === 'web_fetch'
          ? 'Web connection'
          : draft.kind === 'computer_use'
            ? 'Computer-use backend'
            : draft.kind === 'image_descriptor'
              ? 'Image descriptor model'
              : 'Provider connection'}
  </legend>
  {#if draft.kind === 'mcp'}
    <label class="block space-y-1 text-xs font-medium">
      <span>Transport</span>
      <select
        class="h-9 w-full rounded-lg border bg-elevated px-2.5 text-sm outline-none focus:border-primary"
        bind:value={draft.transport}
      >
        <option value="stdio">stdio</option>
        <option value="http">HTTP</option>
        <option value="sse">SSE</option>
      </select>
    </label>
    {#if draft.transport === 'stdio'}
      <label class="block space-y-1 text-xs font-medium">
        <span>Command</span>
        <input
          class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
          bind:value={draft.command}
        />
      </label>
      <label class="block space-y-1 text-xs font-medium">
        <span>Arguments · one per line</span>
        <textarea
          class="min-h-16 w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
          bind:value={draft.args}></textarea>
      </label>
    {:else}
      <label class="block space-y-1 text-xs font-medium">
        <span>URL</span>
        <input
          class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
          type="url"
          bind:value={draft.url}
        />
      </label>
    {/if}
    {#if draft.transport !== 'stdio'}
      <label class="block space-y-1 text-xs font-medium">
        <span>Request headers</span>
        <textarea
          class="min-h-16 w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
          placeholder={'{ "Authorization": "Bearer {env:API_TOKEN}" }'}
          bind:value={draft.headers}></textarea>
      </label>
    {/if}
    {#if isNative || draft.id !== null}
      <label class="block space-y-1 text-xs font-medium">
        <span>Environment</span>
        <textarea
          class="min-h-16 w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
          placeholder={'{ "NODE_ENV": "production" }'}
          bind:value={draft.environment}></textarea>
      </label>
    {/if}
  {:else if draft.kind === 'skill'}
    <RichMarkdownEditor
      id="utility-skill-markdown"
      bind:value={draft.instructions}
      placeholder={skillPlaceholder}
      ariaLabel="Skill Markdown"
      containerClass="rounded-xl border bg-elevated focus-within:border-primary focus-within:ring-1 focus-within:ring-primary"
      class="min-h-72 max-h-96 w-full resize-y overflow-y-auto px-4 py-3 text-sm leading-6 text-foreground outline-none"
    />
    <p class="text-[0.6875rem] text-dimmed">
      Write the complete skill file, including frontmatter and instruction sections. The frontmatter
      name and description identify the installed skill.
    </p>
  {:else if draft.kind === 'web_search' || draft.kind === 'web_fetch'}
    <label class="block space-y-1 text-xs font-medium">
      <span>Endpoint</span>
      <input
        class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
        type="url"
        bind:value={draft.endpoint}
      />
    </label>
    <label class="block space-y-1 text-xs font-medium">
      <span>Request headers</span>
      <textarea
        class="min-h-16 w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
        placeholder={'{ "Authorization": "Bearer {env:WEB_API_KEY}" }'}
        bind:value={draft.headers}></textarea>
    </label>
  {:else if draft.kind === 'computer_use'}
    <label class="block space-y-1 text-xs font-medium">
      <span>Backend</span>
      <input
        class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
        required
        bind:value={draft.backend}
      />
    </label>
    <label class="block space-y-1 text-xs font-medium">
      <span>Endpoint</span>
      <input
        class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
        type="url"
        bind:value={draft.endpoint}
      />
    </label>
  {:else if draft.kind === 'image_descriptor'}
    <label class="block space-y-1 text-xs font-medium">
      <span>Harness ID</span>
      <input
        class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
        placeholder="opencode"
        bind:value={draft.descriptorHarnessId}
      />
    </label>
    <div class="grid grid-cols-2 gap-3">
      <label class="space-y-1 text-xs font-medium">
        <span>Provider ID</span>
        <input
          class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
          placeholder="anthropic"
          bind:value={draft.descriptorProviderId}
        />
      </label>
      <label class="space-y-1 text-xs font-medium">
        <span>Model ID (vision)</span>
        <input
          class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
          placeholder="claude-sonnet-4-5"
          bind:value={draft.descriptorModelId}
        />
      </label>
    </div>
    <p class="text-[0.6875rem] text-dimmed">
      A model from the harness catalog that can see images. Text-only models call this utility to
      describe attached images. Leave the fields empty to let the app pick a vision model
      automatically.
    </p>
  {:else}
    <label class="block space-y-1 text-xs font-medium">
      <span>Provider ID</span>
      <input
        class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
        required
        bind:value={draft.providerId}
      />
    </label>
    <div class="grid grid-cols-2 gap-3">
      <label class="space-y-1 text-xs font-medium">
        <span>Endpoint</span>
        <input
          class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
          type="url"
          bind:value={draft.endpoint}
        />
      </label>
      <label class="space-y-1 text-xs font-medium">
        <span>Default model</span>
        <input
          class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
          bind:value={draft.defaultModel}
        />
      </label>
    </div>
  {/if}
</fieldset>
