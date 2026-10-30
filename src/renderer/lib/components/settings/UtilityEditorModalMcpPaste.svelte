<script lang="ts">
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioClipboardPaste from '@pdslng/cio-icon/CioClipboardPaste.svelte'
  import { parseMcpServerJson, type ImportedMcpServer } from '$shared/mcp-config-import'

  interface Props {
    disabled?: boolean
    /** Fired with the server to fill the editor's connection fields from. */
    onImport: (server: ImportedMcpServer) => void
  }

  let { disabled = false, onImport }: Props = $props()

  /** Folded by default: the fields below are the primary way to fill it in. */
  let open = $state(false)
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
    open = false
  }
</script>

<details class="group border border-dashed bg-elevated" bind:open>
  <summary
    class="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 hover:bg-overlay"
  >
    <span class="flex min-w-0 items-center gap-2">
      <CioClipboardPaste size={14} class="shrink-0 text-muted" />
      <span class="text-xs font-semibold">Paste a configuration</span>
      <span class="truncate text-[0.6875rem] text-muted">Fill these fields from JSON</span>
    </span>
    <CioChevronDown
      size={14}
      class="shrink-0 text-muted transition-transform group-open:rotate-180"
    />
  </summary>
  <div class="border-t p-3">
    <p class="text-[0.6875rem] leading-relaxed text-muted">
      Paste an <span class="font-mono">mcpServers</span> block copied from a README, another harness,
      or a plugin's install notes. Only the server this modal edits changes.
    </p>
    <textarea
      class="mt-2 min-h-20 w-full resize-y border bg-raised px-3 py-2 font-mono text-xs outline-none focus:border-primary disabled:opacity-50"
      aria-label="Paste an MCP server configuration as JSON"
      placeholder={'{\n  "mcpServers": {\n    "server-name": {\n      "command": "/path/to/server",\n      "args": ["--flag"]\n    }\n  }\n}'}
      {disabled}
      bind:value={pasted}></textarea>
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
</details>
