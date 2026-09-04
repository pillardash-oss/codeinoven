<script lang="ts">
  import { ExternalLink, Globe } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import { openInBrowser } from '$lib/open-in-browser'

  interface Props {
    /** Non-empty list of URLs to open. */
    urls: string[]
    /** Descriptive title for the button/trigger (also the aria-label). */
    title?: string
    /** Icon size passed to the trigger icon. */
    size?: number
  }

  let { urls, title = 'Open deployed site', size = 11 }: Props = $props()

  /** Short readable label for a URL (host path, without the protocol). */
  function linkLabel(url: string): string {
    return url.replace(/^https?:\/\//u, '').replace(/\/+$/u, '') || url
  }
</script>

{#if urls.length === 1}
  <button
    type="button"
    class="shrink-0 rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    {title}
    aria-label={title}
    onclick={() => void openInBrowser(urls[0])}
  >
    <ExternalLink {size} />
  </button>
{:else}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="shrink-0 rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
      {title}
      aria-label={title}
    >
      <ExternalLink {size} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        side="bottom"
        align="end"
        sideOffset={4}
        collisionPadding={8}
        class="z-50 w-64 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
      >
        <div class="px-2.5 pb-1 pt-2 text-[0.5625rem] font-semibold uppercase tracking-wide text-muted">
          Open in browser
        </div>
        {#each urls as url (url)}
          <DropdownMenu.Item
            class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs outline-none transition-colors text-foreground hover:bg-elevated focus:bg-elevated"
            onSelect={() => void openInBrowser(url)}
          >
            <Globe size={13} class="shrink-0 text-muted" />
            <span class="truncate font-mono text-[0.625rem]">{linkLabel(url)}</span>
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{/if}
