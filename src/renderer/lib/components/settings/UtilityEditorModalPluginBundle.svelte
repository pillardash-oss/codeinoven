<script lang="ts">
  import { Upload } from '@lucide/svelte'

  interface Props {
    editorError: string
    pluginManifest: string
    onReadPluginFile: (event: Event) => void
  }

  let { editorError, pluginManifest = $bindable(), onReadPluginFile }: Props = $props()
</script>

<div>
  {#if editorError}
    <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {editorError}
    </p>
  {/if}
  <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
    <div>
      <div class="rounded-xl border border-dashed bg-elevated p-5">
        <Upload size={20} class="mb-3 text-muted" />
        <p class="text-sm font-semibold">Import a plugin manifest</p>
        <p class="mt-1 text-xs leading-relaxed text-muted">
          A plugin bundle can install several MCP servers, skills, and web utilities together.
          Installation is atomic: if one entry is invalid, nothing is added.
        </p>
        <label
          class="mt-4 inline-flex h-9 cursor-pointer items-center rounded-lg border bg-surface px-3 text-xs font-medium hover:bg-overlay"
        >
          Choose JSON file
          <input
            class="sr-only"
            type="file"
            accept=".json,application/json"
            onchange={onReadPluginFile}
          />
        </label>
      </div>
      <label class="mt-4 block space-y-1 text-xs font-medium">
        <span>Or paste the manifest</span>
        <textarea
          class="min-h-64 w-full resize-y rounded-xl border bg-raised px-3 py-2 font-mono text-xs outline-none focus:border-primary"
          placeholder={'{\n  "name": "My plugin",\n  "utilities": [\n    { "definition": { ... }, "credentials": [] }\n  ]\n}'}
          bind:value={pluginManifest}></textarea>
      </label>
    </div>
    <aside class="rounded-xl bg-raised p-4">
      <p class="text-xs font-semibold uppercase tracking-wide text-muted">Plugin format</p>
      <ul class="mt-3 space-y-2 text-xs leading-relaxed text-muted">
        <li>One manifest can contain MCP, skill, web search, and web fetch entries.</li>
        <li>Each entry uses the same fields as a single installed capability.</li>
        <li>Secret values are moved into secure storage and never returned to the UI.</li>
        <li>All entries are validated before the registry changes.</li>
      </ul>
    </aside>
  </div>
</div>
