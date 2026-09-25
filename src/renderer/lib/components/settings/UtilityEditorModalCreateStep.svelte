<script lang="ts">
  import { BookOpen, Boxes, Server, Sparkles } from '@lucide/svelte'

  interface Props {
    onChooseCreate: (id: 'skill' | 'mcp' | 'plugin') => void
    onBeginAgentSetup: () => void
  }

  let { onChooseCreate, onBeginAgentSetup }: Props = $props()

  const createChoices: Array<{
    id: 'skill' | 'mcp' | 'plugin'
    title: string
    description: string
    icon: typeof BookOpen
  }> = [
    {
      id: 'skill',
      title: 'Skill',
      description: 'Paste SKILL.md instructions an agent can load on demand.',
      icon: BookOpen
    },
    {
      id: 'mcp',
      title: 'MCP server',
      description: 'Connect an MCP server over stdio, HTTP, or SSE directly.',
      icon: Server
    },
    {
      id: 'plugin',
      title: 'Plugin bundle',
      description: 'Import a JSON manifest that installs several capabilities atomically.',
      icon: Boxes
    }
  ]
</script>

<div>
  <div class="mb-5 rounded-xl bg-raised p-4">
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
        class="group min-h-28 rounded-xl border bg-elevated p-4 text-left transition-colors hover:border-primary hover:bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onclick={() => onChooseCreate(choice.id)}
      >
        <span
          class="flex h-8 w-8 items-center justify-center rounded-lg bg-surface text-muted group-hover:text-foreground"
        >
          <choice.icon size={16} />
        </span>
        <span class="mt-3 block text-sm font-semibold">{choice.title}</span>
        <span class="mt-1 block text-xs leading-relaxed text-muted">{choice.description}</span>
      </button>
    {/each}
  </div>
  <div
    class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed bg-elevated p-4"
  >
    <div>
      <p class="text-sm font-semibold">Prefer setup by an agent?</p>
      <p class="mt-1 text-xs leading-relaxed text-muted">
        Let a CIO agent build the skill, MCP server, or plugin for the harnesses you use.
      </p>
    </div>
    <button
      type="button"
      class="flex h-9 items-center gap-1.5 rounded-lg border bg-surface px-3 text-xs font-medium text-muted hover:bg-overlay hover:text-foreground"
      title="Set up a utility with a disposable agent session"
      onclick={onBeginAgentSetup}
    >
      <Sparkles size={14} />
      Setup with agent
    </button>
  </div>
</div>
