<script lang="ts">
  import CioClipboardPaste from '@pdslng/cio-icon/CioClipboardPaste.svelte'
  import { parseMcpServerJson, type ImportedMcpServer } from '$shared/mcp-config-import'

  interface Props {
    disabled?: boolean
    /** Fired with the server to fill the editor's connection fields from. */
    onImport: (server: ImportedMcpServer) => void
  }

  let { disabled = false, onImport }: Props = $props()

  let pasted = $state('')
  let error = $state('')
  /** Servers a multi-server paste offered, awaiting the user's pick. */
  let choices = $state<ImportedMcpServer[]>([])

  function readPaste(): void {
    error = ''
    choices = []
    try {
      const [first, ...rest] = parseMcpServerJson(pasted)
      if (!first) return
      if (rest.length > 0) {
        choices = [first, ...rest]
        return
      }
      fill(first)
    } catch (parseError) {
      error =
        parseError instanceof Error ? parseError.message : 'That configuration could not be read.'
    }
  }

  function fill(server: ImportedMcpServer): void {
    onImport(server)
    pasted = ''
    choices = []
    error = ''
  }
</script>

<div class="border border-dashed bg-elevated p-3">
  <div class="flex items-start gap-2">
    <CioClipboardPaste size={16} class="mt-0.5 shrink-0 text-muted" />
    <div class="min-w-0">
      <p class="text-xs font-semibold">Paste a configuration</p>
      <p class="mt-0.5 text-[0.6875rem] leading-relaxed text-muted">
        Paste an <span class="font-mono">mcpServers</span> block copied from a README, another
        harness, or a plugin's install notes and these fields fill themselves. Only the server this
        modal edits is changed.
      </p>
    </div>
  </div>
  <textarea
    class="mt-2 min-h-20 w-full resize-y border bg-raised px-3 py-2 font-mono text-xs outline-none focus:border-primary disabled:opacity-50"
    aria-label="Paste an MCP server configuration as JSON"
    placeholder={'{\n  "mcpServers": {\n    "server-name": {\n      "command": "/path/to/server",\n      "args": ["--flag"]\n    }\n  }\n}'}
    disabled={disabled}
    bind:value={pasted}
  ></textarea>
  {#if error}
    <p class="mt-1 text-[0.6875rem] text-danger" role="alert">{error}</p>
  {/if}
  {#if choices.length > 0}
    <p class="mt-2 text-[0.6875rem] text-muted">
      {choices.length} servers in that JSON. Choose the one to fill in:
    </p>
    <div class="mt-1 flex flex-wrap gap-1.5">
      {#each choices as server (server.name)}
        <button
          type="button"
          class="h-8 border bg-surface px-2.5 text-xs font-medium hover:bg-overlay hover:text-foreground"
          title={`Fill the connection fields from ${server.name}`}
          onclick={() => fill(server)}
        >
          {server.name}
        </button>
      {/each}
    </div>
  {/if}
  <div class="mt-2 flex justify-end">
    <button
      class="h-8 bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
      type="button"
      disabled={disabled || pasted.trim() === ''}
      onclick={readPaste}
    >
      Fill fields
    </button>
  </div>
</div>
