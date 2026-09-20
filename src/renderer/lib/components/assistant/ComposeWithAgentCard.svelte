<script lang="ts">
  import { Sparkles } from '@lucide/svelte'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { threadSettings } from '$lib/stores/thread-settings.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import type { Routine, Thread } from '$shared/types'

  interface Props {
    task: Thread
    routine: Routine | null
  }

  let { task, routine }: Props = $props()

  let intent = $state('')
  let sending = $state(false)

  /**
   * The agent always authors the how-to: the user describes what they want and
   * the agent works out the tools, researches anything missing, asks for
   * consent before installing, then writes the how-to.
   */
  function composePrompt(): string {
    const routineName = routine?.name ?? task.title
    const goal = intent.trim()
    return [
      `I want this routine ("${routineName}") to work. Here is what I want it to do:`,
      goal.length > 0 ? goal : '(describe the goal first)',
      '',
      'Write the how-to for this routine. Before you write it:',
      '1. Work out exactly what information, services, and tools the tasks need.',
      '2. Check the app utility library for a matching skill, MCP server, or plugin. If one is missing, research whether a compatible option exists and explain plainly what it is and how to set it up.',
      '3. Never install anything without my consent. When a compatible utility can be installed, tell me to send "@cio-utility proceed" so I can arm the install.',
      '4. If nothing compatible exists, offer the fallbacks you have (browser or computer use) and ask which I prefer.',
      'Finish by writing the how-to as a clear, step-by-step prompt that every task in this routine will follow.'
    ].join('\n')
  }

  async function composeWithAgent(): Promise<void> {
    if (sending || intent.trim().length === 0) return
    sending = true
    const settings = task.settings ?? threadSettings.lastUsed
    try {
      await threadMessages.send(
        task.projectId,
        task.id,
        settings,
        composePrompt(),
        [],
        undefined
      )
      intent = ''
    } catch (error) {
      reportError(error, 'Could not start the how-to authoring turn')
    } finally {
      sending = false
    }
  }
</script>

<div class="rounded-lg border border-border bg-elevated/50 p-3">
  <div class="mb-2 flex items-center gap-1.5">
    <Sparkles size={14} strokeWidth={1.8} class="text-accent" />
    <span class="text-[0.75rem] font-medium text-foreground">Compose with agent</span>
  </div>
  <p class="mb-2 text-[0.6875rem] text-muted">
    Describe what you want this routine to do. The agent works out what it needs, checks the
    utility library, researches anything missing, and writes the how-to with you.
  </p>
  <textarea
    class="min-h-16 w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-[0.75rem] text-foreground placeholder:text-dimmed focus:border-border-strong focus:outline-none"
    placeholder="e.g. Check my email every morning and report anything important"
    aria-label="Routine goal for the agent"
    bind:value={intent}
  ></textarea>
  <div class="mt-2 flex justify-end">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[0.75rem] text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
      disabled={sending || intent.trim().length === 0}
      onclick={() => void composeWithAgent()}
    >
      <Sparkles size={13} strokeWidth={1.8} />
      {sending ? 'Starting…' : 'Compose with agent'}
    </button>
  </div>
</div>
