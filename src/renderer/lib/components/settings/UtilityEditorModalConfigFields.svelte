<script lang="ts">
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { DEFAULT_HARNESS } from '$shared/harness-default'
  import type { ImportedMcpServer } from '$shared/mcp-config-import'
  import type { ProviderCatalog } from '$shared/types'
  import UtilityEditorModalMcpPaste from './UtilityEditorModalMcpPaste.svelte'
  import {
    applyMcpImport,
    skillPlaceholder,
    type UtilityDraft
  } from './utility-editor-modal-helpers'

  interface Props {
    draft: UtilityDraft
    isNative: boolean
    /**
     * Catalogs every harness reports, so the vision-model picker can list the
     * models that can actually see an image.
     */
    providers?: ProviderCatalog[]
    /**
     * Pi 0.99 rejects `type: "sse"` outright ("legacy SSE transport is not
     * supported; use the streamable HTTP URL"), so its own entries must not
     * be offered a transport saving them would break.
     */
    allowSse?: boolean
    /**
     * Shows the section read-only. An app-owned entry whose wiring the app
     * supplies has no configuration a user may change, so the editor shows
     * what the app installed instead of offering an edit it would not honour.
     */
    locked?: boolean
  }

  let {
    draft = $bindable(),
    isNative,
    allowSse = true,
    locked = false,
    providers = []
  }: Props = $props()

  /** Fill the connection fields from a server read out of a pasted config. */
  function importPastedServer(server: ImportedMcpServer): void {
    applyMcpImport(draft, server, allowSse)
  }
</script>

<fieldset class="space-y-3 border p-3 {locked ? 'opacity-60' : ''}">
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
              ? 'Vision model'
              : 'Provider connection'}
  </legend>
  {#if draft.kind === 'mcp'}
    {#if !locked}
      <UtilityEditorModalMcpPaste onImport={importPastedServer} />
    {/if}
    <label class="block space-y-1 text-xs font-medium">
      <span>Transport</span>
      <select
        class="h-9 w-full border bg-elevated px-2.5 text-sm outline-none focus:border-primary"
        disabled={locked}
        bind:value={draft.transport}
      >
        <option value="stdio">stdio</option>
        <option value="http">HTTP</option>
        {#if allowSse}
          <option value="sse">SSE</option>
        {/if}
      </select>
    </label>
    {#if draft.transport === 'stdio'}
      <label class="block space-y-1 text-xs font-medium">
        <span>Command</span>
        <input
          class="h-9 w-full border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
          disabled={locked}
          bind:value={draft.command}
        />
      </label>
      <label class="block space-y-1 text-xs font-medium">
        <span>Arguments · one per line</span>
        <textarea
          class="min-h-16 w-full border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
          disabled={locked}
          bind:value={draft.args}></textarea>
      </label>
    {:else}
      <label class="block space-y-1 text-xs font-medium">
        <span>URL</span>
        <input
          class="h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary"
          type="url"
          disabled={locked}
          bind:value={draft.url}
        />
      </label>
    {/if}
    {#if draft.transport !== 'stdio'}
      <label class="block space-y-1 text-xs font-medium">
        <span>Request headers</span>
        <textarea
          class="min-h-16 w-full border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
          placeholder={'{ "Authorization": "Bearer {env:API_TOKEN}" }'}
          disabled={locked}
          bind:value={draft.headers}></textarea>
      </label>
    {/if}
    <label class="block space-y-1 text-xs font-medium">
      <span>Environment</span>
      <textarea
        class="min-h-16 w-full border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
        placeholder={'{ "NODE_ENV": "production" }'}
        disabled={locked}
        bind:value={draft.environment}></textarea>
    </label>
    {#if !isNative && draft.id === null}
      <p class="text-[0.6875rem] text-dimmed">
        Plain environment values are stored with the server. Store a secret as a credential instead,
        so it stays in encrypted storage.
      </p>
    {/if}
  {:else if draft.kind === 'skill'}
    <RichMarkdownEditor
      id="utility-skill-markdown"
      disabled={locked}
      bind:value={draft.instructions}
      placeholder={skillPlaceholder}
      ariaLabel="Skill Markdown"
      containerClass="border bg-elevated focus-within:border-primary focus-within:ring-1 focus-within:ring-primary"
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
        class="h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary"
        type="url"
        disabled={locked}
        bind:value={draft.endpoint}
      />
    </label>
    <label class="block space-y-1 text-xs font-medium">
      <span>Request headers</span>
      <textarea
        class="min-h-16 w-full border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
        placeholder={'{ "Authorization": "Bearer {env:WEB_API_KEY}" }'}
        disabled={locked}
        bind:value={draft.headers}></textarea>
    </label>
  {:else if draft.kind === 'computer_use'}
    <label class="block space-y-1 text-xs font-medium">
      <span>Backend</span>
      <input
        class="h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary"
        required
        disabled={locked}
        bind:value={draft.backend}
      />
    </label>
    <label class="block space-y-1 text-xs font-medium">
      <span>Endpoint</span>
      <input
        class="h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary"
        type="url"
        disabled={locked}
        bind:value={draft.endpoint}
      />
    </label>
  {:else if draft.kind === 'image_descriptor'}
    <ModelPicker
      {providers}
      harnessId={draft.descriptorHarnessId || providers[0]?.harnessId || DEFAULT_HARNESS}
      providerId={draft.descriptorProviderId}
      modelId={draft.descriptorModelId}
      visionOnly
      side="bottom"
      variant="field"
      label={draft.descriptorModelId ? undefined : 'Choose a vision model'}
      onSelect={(providerId, modelId, harnessId) => {
        draft.descriptorProviderId = providerId
        draft.descriptorModelId = modelId
        draft.descriptorHarnessId = harnessId
      }}
    />
    <p class="text-[0.6875rem] text-dimmed">
      The vision model this utility describes images with. Text-only models call it for images
      attached to their turn. Leave it unpicked and the app chooses a vision model automatically.
    </p>
  {:else}
    <label class="block space-y-1 text-xs font-medium">
      <span>Provider ID</span>
      <input
        class="h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary"
        required
        disabled={locked}
        bind:value={draft.providerId}
      />
    </label>
    <div class="grid grid-cols-2 gap-3">
      <label class="space-y-1 text-xs font-medium">
        <span>Endpoint</span>
        <input
          class="h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary"
          type="url"
          disabled={locked}
          bind:value={draft.endpoint}
        />
      </label>
      <label class="space-y-1 text-xs font-medium">
        <span>Default model</span>
        <input
          class="h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary"
          disabled={locked}
          bind:value={draft.defaultModel}
        />
      </label>
    </div>
  {/if}
</fieldset>
