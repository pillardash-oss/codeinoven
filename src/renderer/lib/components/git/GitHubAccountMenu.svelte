<script lang="ts">
  import { ExternalLink, GitFork, LogOut, User } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import type { GitHubAuthStatus } from '$shared/types'

  interface Props {
    /** GitHub account status for the signed-in user. */
    github: GitHubAuthStatus
    /** Primary remote (origin), used to link straight to the repository. */
    primaryRemote: { name: string; url: string } | null
    onSignIn: () => void
    onSignOut: () => void
  }

  let { github, primaryRemote, onSignIn, onSignOut }: Props = $props()

  let open = $state(false)

  const user = $derived(github.user ?? null)

  /** Browsable https URL for the remote, from either an ssh or https origin. */
  const remoteWebUrl = $derived.by(() => {
    const url = primaryRemote?.url?.trim()
    if (!url) return null
    const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/.exec(url)
    if (ssh) return `https://${ssh[1]}/${ssh[2]}`
    if (/^https?:\/\//.test(url)) return url.replace(/\.git$/, '')
    return null
  })

  async function openUrl(url: string): Promise<void> {
    open = false
    await openInBrowser(url)
  }
</script>

{#if github.connected && user}
  <DropdownMenu.Root bind:open>
    <DropdownMenu.Trigger
      class="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-elevated data-[state=open]:bg-elevated"
      title="GitHub account — {user.name ?? user.login} (@{user.login})"
      aria-label="GitHub account for {user.login}"
    >
      {#if user.avatarUrl}
        <img src={user.avatarUrl} alt="" class="h-5 w-5 rounded-full bg-elevated" />
      {:else}
        <VendorIcon name="GitHub" size={14} />
      {/if}
    </DropdownMenu.Trigger>

    <DropdownMenu.Portal>
      <DropdownMenu.Content
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        class="z-50 w-60 overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
      >
        <div class="flex items-center gap-2 border-b border-border px-3 py-2">
          {#if user.avatarUrl}
            <img src={user.avatarUrl} alt="" class="h-7 w-7 shrink-0 rounded-full bg-elevated" />
          {:else}
            <span
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-elevated"
            >
              <VendorIcon name="GitHub" size={14} />
            </span>
          {/if}
          <div class="min-w-0 flex-1">
            <p class="truncate text-[11px] font-medium text-foreground">
              {user.name ?? user.login}
            </p>
            <p class="truncate text-[9px] text-dimmed">@{user.login}</p>
          </div>
          <VendorIcon name="GitHub" size={13} class="shrink-0 text-dimmed" />
        </div>

        <div class="py-1">
          {#if remoteWebUrl}
            <DropdownMenu.Item
              class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[11px] text-foreground outline-none transition-colors data-highlighted:bg-elevated"
              onSelect={() => void openUrl(remoteWebUrl)}
            >
              <ExternalLink size={12} class="shrink-0 text-dimmed" />
              Open repository on GitHub
            </DropdownMenu.Item>
          {/if}
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[11px] text-foreground outline-none transition-colors data-highlighted:bg-elevated"
            onSelect={() => void openUrl(`https://github.com/${user.login}`)}
          >
            <User size={12} class="shrink-0 text-dimmed" />
            View my GitHub profile
          </DropdownMenu.Item>
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[11px] text-foreground outline-none transition-colors data-highlighted:bg-elevated"
            onSelect={() => void openUrl('https://github.com/pulls')}
          >
            <GitFork size={12} class="shrink-0 text-dimmed" />
            My pull requests
          </DropdownMenu.Item>
          <DropdownMenu.Separator class="my-1 h-px bg-border" />
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[11px] text-danger outline-none transition-colors data-highlighted:bg-danger/10"
            onSelect={() => {
              open = false
              onSignOut()
            }}
          >
            <LogOut size={12} class="shrink-0" />
            Sign out of GitHub
          </DropdownMenu.Item>
        </div>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{:else if github.configured}
  <button
    type="button"
    class="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
    title="Sign in to GitHub"
    aria-label="Sign in to GitHub"
    onclick={onSignIn}
  >
    <VendorIcon name="GitHub" size={14} />
  </button>
{/if}
