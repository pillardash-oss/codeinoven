<script lang="ts">
  import CioBook from '@pillardash-oss/cio-icon/CioBook.svelte'
  import CioServer from '@pillardash-oss/cio-icon/CioServer.svelte'
  import CioSparkles from '@pillardash-oss/cio-icon/CioSparkles.svelte'
  import CioTabBoxes from '@pillardash-oss/cio-icon/CioTabBoxes.svelte'
  interface Props {
    onChooseCreate: (id: 'skill' | 'mcp' | 'plugin') => void
    onStartSetupThread: () => void
    /** Why the assisted path did not open a thread, when it could not. */
    error?: string
    /** True while a setup thread is being opened, so a second click waits. */
    busy?: boolean
  }

  let { onChooseCreate, onStartSetupThread, error = '', busy = false }: Props = $props()

  const createChoices: Array<{
    id: 'skill' | 'mcp' | 'plugin'
    title: string
    description: string
    icon: typeof CioBook
  }> = [
    {
      id: 'skill',
      title: 'Skill',
      description: 'Paste SKILL.md instructions an agent can load on demand.',
      icon: CioBook
    },
    {
      id: 'mcp',
      title: 'MCP server',
      description: 'Connect an MCP server over stdio, HTTP, or SSE directly.',
      icon: CioServer
    },
    {
      id: 'plugin',
      title: 'Plugin bundle',
      description: 'Import a JSON manifest that installs several capabilities atomically.',
      icon: CioTabBoxes
    }
  ]
</script>

<div>
  {#if error}
    <p class="mb-3 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {error}
    </p>
  {/if}
  <div class="mb-5 border bg-raised p-4">
    <p class="text-sm font-semibold">What do you want to set up?</p>
    <p class="mt-1 text-xs leading-relaxed text-muted">
      CodeInOven wires every harness. Paste a skill, connect an MCP server, or import a plugin
      bundle.
    </p>
  </div>
  <div class="grid gap-2 md:grid-cols-3">
    {#each createChoices as choice (choice.id)}
      <button
        type="button"
        class="group min-h-28 border bg-elevated p-4 text-left transition-colors hover:border-primary hover:bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onclick={() => onChooseCreate(choice.id)}
      >
        <span
          class="flex h-8 w-8 items-center justify-center bg-surface text-muted group-hover:text-foreground"
        >
          <choice.icon size={16} />
        </span>
        <span class="mt-3 block text-sm font-semibold">{choice.title}</span>
        <span class="mt-1 block text-xs leading-relaxed text-muted">{choice.description}</span>
      </button>
    {/each}
  </div>
  <div
    class="mt-4 flex flex-wrap items-center justify-between gap-3 border border-dashed bg-elevated p-4"
  >
    <div>
      <p class="text-sm font-semibold">Prefer setup by an agent?</p>
      <p class="mt-1 text-xs leading-relaxed text-muted">
        CodeInOven opens a thread with @cio-utility already written for you: say what you want set
        up, then watch the agent build it and steer where it goes.
      </p>
    </div>
    <button
      type="button"
      class="flex h-9 items-center gap-1.5 border bg-surface px-3 text-xs font-medium text-muted hover:bg-overlay hover:text-foreground disabled:cursor-default disabled:opacity-50"
      title="Open a thread that sets this utility up with an agent"
      disabled={busy}
      onclick={onStartSetupThread}
    >
      <CioSparkles size={14} />
      Setup with agent
    </button>
  </div>
</div>
