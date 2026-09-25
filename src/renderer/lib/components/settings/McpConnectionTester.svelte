<script lang="ts">
  import { CircleCheck, Loader2, PlugZap, TriangleAlert } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { McpConnectionTestResult, McpProbeTarget } from '$shared/types'

  interface Props {
    /** Builds the request when the test runs, so an editor tests what is on screen. */
    probe: () => McpProbeTarget
    /** What is being tested, named in the button's title and accessibility label. */
    subject: string
    /** `row` is the compact entry-list line; `panel` adds the full tool report. */
    variant?: 'row' | 'panel'
    disabled?: boolean
  }

  let { probe, subject, variant = 'row', disabled = false }: Props = $props()

  let running = $state(false)
  let result = $state<McpConnectionTestResult | null>(null)
  let failure = $state('')

  const label = $derived(`Test the ${subject} connection`)

  async function run(): Promise<void> {
    running = true
    result = null
    failure = ''
    try {
      result = await invoke('utilities:testMcp', probe())
    } catch (error) {
      failure = error instanceof Error ? error.message : 'The connection test could not run.'
    } finally {
      running = false
    }
  }

  /** The server's own name when it introduced itself, so the answer is attributable. */
  let answeredBy = $derived(
    result?.serverName ? `“${result.serverName}” answered` : 'Server answered'
  )

  /** The failure reason a failed test reports. */
  let reason = $derived(result?.error ?? 'The server did not answer.')

  /** A row clamps a long reason, so the full text stays reachable on hover there. */
  function rowTitle(text: string): string | undefined {
    return variant === 'row' ? text : undefined
  }
</script>

<div
  class={variant === 'panel'
    ? 'space-y-2 rounded-xl border bg-raised p-3'
    : 'mt-2 flex flex-wrap items-center gap-2'}
>
  <button
    type="button"
    class="flex items-center gap-1.5 rounded-lg border bg-elevated font-medium hover:bg-overlay disabled:opacity-50 {variant ===
    'panel'
      ? 'h-9 px-3 text-xs'
      : 'h-7 px-2.5 text-[0.6875rem]'}"
    title={label}
    aria-label={label}
    disabled={disabled || running}
    onclick={() => void run()}
  >
    {#if running}
      <Loader2 size={13} class="animate-spin" />
    {:else}
      <PlugZap size={13} />
    {/if}
    {running ? 'Testing…' : 'Test connection'}
  </button>

  {#if failure}
    <p class="flex items-start gap-1.5 text-[0.6875rem] text-danger" role="alert">
      <TriangleAlert size={12} class="mt-0.5 shrink-0" />
      <span class={variant === 'row' ? 'line-clamp-2' : ''} title={rowTitle(failure)}
        >{failure}</span
      >
    </p>
  {:else if result}
    {#if result.ok}
      <p class="flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-success">
        <CircleCheck size={12} class="shrink-0" />
        <span>
          {answeredBy} in {result.latencyMs} ms with {result.toolCount}
          {result.toolCount === 1 ? 'tool' : 'tools'}
        </span>
      </p>
    {:else}
      <p class="flex items-start gap-1.5 text-[0.6875rem] text-danger" role="alert">
        <TriangleAlert size={12} class="mt-0.5 shrink-0" />
        <span class={variant === 'row' ? 'line-clamp-2' : ''} title={rowTitle(reason)}>
          {reason}
        </span>
      </p>
    {/if}

    {#if result.missingCredentials.length}
      <p class="text-[0.6875rem] text-warning">
        No value stored for {result.missingCredentials.join(', ')}.
      </p>
    {/if}

    {#if variant === 'panel'}
      {#if result.target}
        <p class="truncate font-mono text-[0.625rem] text-dimmed" title={result.target}>
          {result.target}
        </p>
      {/if}
      {#if result.ok}
        <details class="rounded-lg border bg-surface">
          <summary
            class="cursor-pointer px-3 py-2 text-[0.6875rem] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {result.toolCount === 1 ? 'Advertised tool' : 'Advertised tools'}
            <span class="text-dimmed">· {result.toolCount}</span>
          </summary>
          {#if result.tools.length}
            <ul class="max-h-64 space-y-1.5 overflow-auto border-t p-3">
              {#each result.tools as tool (tool.name)}
                <li class="text-[0.6875rem] leading-relaxed">
                  <span class="font-mono font-semibold">{tool.name}</span>
                  {#if tool.description}
                    <span class="text-muted"> · {tool.description}</span>
                  {/if}
                </li>
              {/each}
            </ul>
            {#if result.toolCount > result.tools.length}
              <p class="border-t px-3 py-1.5 text-[0.6875rem] text-dimmed">
                Showing the first {result.tools.length} of {result.toolCount}.
              </p>
            {/if}
          {:else}
            <p class="border-t px-3 py-2 text-[0.6875rem] text-dimmed">
              The server answered but advertised no tools.
            </p>
          {/if}
        </details>
      {/if}
    {/if}
  {/if}
</div>
