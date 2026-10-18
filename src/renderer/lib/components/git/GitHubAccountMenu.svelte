<script lang="ts">
  import CioCheck from 'cio-icon/CioCheck.svelte'
  import CioExternalLink from 'cio-icon/CioExternalLink.svelte'
  import CioFork from 'cio-icon/CioFork.svelte'
  import CioLogOut from 'cio-icon/CioLogOut.svelte'
  import CioNotifications from 'cio-icon/CioNotifications.svelte'
  import CioPerson from 'cio-icon/CioPerson.svelte'
  import CioPlus from 'cio-icon/CioPlus.svelte'
  import { DropdownMenu } from 'bits-ui'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import type { GitHubAuthStatus } from '$shared/types'

  interface Props {
    /** Every signed-in GitHub account, and which one is active. */
    github: GitHubAuthStatus
    /** Primary remote (origin), used to link straight to the repository. */
    primaryRemote: { name: string; url: string } | null
    /** Starts the device flow, for the first account or another one. */
    onSignIn: () => void
    /** Sign the active account out, moving on to the next one if there is one. */
    onSignOut: () => void
    /** Make another signed-in account the active one. */
    onSwitchAccount: (accountId: string) => void
    /** Take the Git panel to its Notifications view. */
    onOpenNotifications: () => void
  }

  let { github, primaryRemote, onSignIn, onSignOut, onSwitchAccount, onOpenNotifications }: Props =
    $props()

  let open = $state(false)

  const user = $derived(github.user ?? null)
  /**
   * The active account as the list knows it.
   *
   * The profile read is what supplies an avatar, and it needs the network; the
   * account list is already on hand, so the menu still names the signed-in
   * account while that read is unavailable instead of falling back to a sign-in
   * button for an account that is in fact signed in.
   */
  const activeAccount = $derived(github.accounts.find((account) => account.active) ?? null)
  const activeLogin = $derived(user?.login ?? activeAccount?.login ?? '')
  const activeName = $derived(user?.name ?? activeAccount?.name ?? activeLogin)
  /**
   * Whether the switcher is worth drawing. One account needs no choice, and the
   * "add another account" row is the only account control it would otherwise see.
   */
  const multipleAccounts = $derived(github.accounts.length > 1)

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

  /**
   * The two profile destinations this menu opens, named once each.
   *
   * A row and the `data-external-url` it declares have to be the same URL, since
   * the declared one is what the shared right-click menu offers to open and copy.
   * A second copy of the literal here would only be a way to get them wrong.
   */
  const profileUrl = $derived(`https://github.com/${activeLogin}`)
  const myPullRequestsUrl = 'https://github.com/pulls'
</script>

{#if github.connected}
  <DropdownMenu.Root bind:open>
    <DropdownMenu.Trigger
      class="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center transition-colors hover:bg-elevated data-[state=open]:bg-elevated"
      title="GitHub account   {activeName}{activeLogin ? ` (@${activeLogin})` : ''}"
      aria-label={activeLogin ? `GitHub account for ${activeLogin}` : 'GitHub account'}
    >
      {#if user?.avatarUrl}
        <img src={user.avatarUrl} alt="" class="h-5 w-5 bg-elevated" />
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
        class="z-50 w-60 overflow-hidden border border-border bg-surface shadow-xl"
      >
        <div class="flex items-center gap-2 border-b border-border px-3 py-2">
          {#if user?.avatarUrl}
            <img src={user.avatarUrl} alt="" class="h-7 w-7 shrink-0 bg-elevated" />
          {:else}
            <span class="flex h-7 w-7 shrink-0 items-center justify-center bg-elevated">
              <VendorIcon name="GitHub" size={14} />
            </span>
          {/if}
          <div class="min-w-0 flex-1">
            <p class="truncate text-[0.6875rem] font-medium text-foreground">{activeName}</p>
            {#if activeLogin}
              <p class="truncate text-[0.5625rem] text-dimmed">@{activeLogin}</p>
            {/if}
          </div>
          <VendorIcon name="GitHub" size={13} class="shrink-0 text-dimmed" />
        </div>

        {#if multipleAccounts}
          <!--
            Every signed-in account, with the active one marked. A user may be
            signed in with several, and the whole panel reads as the active one:
            its pull requests, its deployments, its notifications.
          -->
          <div class="border-b border-border py-1">
            {#each github.accounts as account (account.id)}
              <DropdownMenu.Item
                class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none transition-colors data-highlighted:bg-elevated"
                title={account.active
                  ? `GitHub calls are running as @${account.login}`
                  : `Switch to @${account.login}`}
                onSelect={() => {
                  open = false
                  onSwitchAccount(account.id)
                }}
              >
                <span class="flex h-3 w-3 shrink-0 items-center justify-center">
                  {#if account.active}
                    <CioCheck size={12} class="text-primary" aria-hidden="true" />
                  {/if}
                </span>
                <span class="min-w-0 flex-1 truncate">
                  {account.login ? `@${account.login}` : 'GitHub account'}
                </span>
              </DropdownMenu.Item>
            {/each}
          </div>
        {/if}

        <div class="py-1">
          {#if remoteWebUrl}
            <DropdownMenu.Item
              class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none transition-colors data-highlighted:bg-elevated"
              data-external-url={remoteWebUrl}
              onSelect={() => void openUrl(remoteWebUrl)}
            >
              <CioExternalLink size={12} class="shrink-0 text-dimmed" />
              Open repository on GitHub
            </DropdownMenu.Item>
          {/if}
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none transition-colors data-highlighted:bg-elevated"
            data-external-url={profileUrl}
            onSelect={() => void openUrl(profileUrl)}
          >
            <CioPerson size={12} class="shrink-0 text-dimmed" />
            View my GitHub profile
          </DropdownMenu.Item>
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none transition-colors data-highlighted:bg-elevated"
            data-external-url={myPullRequestsUrl}
            onSelect={() => void openUrl(myPullRequestsUrl)}
          >
            <CioFork size={12} class="shrink-0 text-dimmed" />
            My pull requests
          </DropdownMenu.Item>
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none transition-colors data-highlighted:bg-elevated"
            onSelect={() => {
              open = false
              onOpenNotifications()
            }}
          >
            <CioNotifications size={12} class="shrink-0 text-dimmed" />
            Notifications
          </DropdownMenu.Item>
          <DropdownMenu.Separator class="my-1 h-px bg-border" />
          <!--
            Adding an account is the same device flow as the first sign-in, so a
            second account needs no second control: this row names what the flow
            is for when one is already signed in.
          -->
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none transition-colors data-highlighted:bg-elevated"
            title="Sign in with another GitHub account"
            onSelect={() => {
              open = false
              onSignIn()
            }}
          >
            <CioPlus size={12} class="shrink-0 text-dimmed" />
            Add another account
          </DropdownMenu.Item>
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-danger outline-none transition-colors data-highlighted:bg-danger/10"
            title={activeLogin ? `Sign out of @${activeLogin}` : 'Sign out of GitHub'}
            onSelect={() => {
              open = false
              onSignOut()
            }}
          >
            <CioLogOut size={12} class="shrink-0" />
            Sign out of {activeLogin ? `@${activeLogin}` : 'GitHub'}
          </DropdownMenu.Item>
        </div>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{:else if github.configured}
  <button
    type="button"
    class="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground"
    title="Sign in to GitHub"
    aria-label="Sign in to GitHub"
    onclick={onSignIn}
  >
    <VendorIcon name="GitHub" size={14} />
  </button>
{/if}
