<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte'
  import EnumSelect from '$lib/components/ui/EnumSelect.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import {
    SITE_PERMISSION_CATALOG,
    SITE_PERMISSION_GROUPS,
    type SitePermissionDescriptor
  } from '$shared/browser/site-permissions'
  import type { BrowserSitePermissionState } from '$shared/ipc-contract'

  /**
   * The Site Permissions modal: every permission the embedded browser exposes,
   * for one site, each set to Ask, Allow or Block.
   *
   * It replaces the padlock's four hardcoded submenus. The list is driven from
   * the shared catalog rather than written out here, so a Chromium permission
   * this app gained no other UI for is still one the user can inspect and reset,
   * and the decisions it writes are the very ledger keys the page-initiated
   * prompt writes.
   *
   * The states arrive with the open event, so the modal draws complete on its
   * first frame instead of asking main for a second round trip. A choice is shown
   * immediately and saved behind it.
   */

  const prompt = $derived(globalBrowser.sitePermissionsPrompt)
  const open = $derived(prompt !== null)

  /** The three states, in the order a user meets them: the safe default first. */
  const STATE_OPTIONS = [
    {
      id: 'ask' as const,
      label: 'Ask',
      hint: 'Prompt me each time the site asks'
    },
    { id: 'allow' as const, label: 'Allow', hint: 'Never ask again for this site' },
    { id: 'block' as const, label: 'Block', hint: 'Refuse silently for this site' }
  ]

  interface Section {
    id: string
    label: string
    entries: readonly SitePermissionDescriptor[]
  }

  const sections = $derived<Section[]>(
    SITE_PERMISSION_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      entries: SITE_PERMISSION_CATALOG.filter((descriptor) => descriptor.group === group.id)
    })).filter((section) => section.entries.length > 0)
  )

  /** The current state of one permission, defaulting to Ask when main sent none. */
  function stateFor(id: string): BrowserSitePermissionState {
    return prompt?.states[id] ?? 'ask'
  }

  function choose(id: string, action: BrowserSitePermissionState): void {
    void globalBrowser.setSitePermission(id, action)
  }
</script>

<Modal
  {open}
  title="Site permissions"
  description="What this site is allowed to use in this browser"
  onClose={() => globalBrowser.dismissSitePermissions()}
  size="lg"
  contentClass="overflow-y-auto p-0"
>
  {#if prompt}
    <div class="border-b border-border px-6 py-4">
      <p class="truncate text-sm font-medium text-foreground">{prompt.host || prompt.origin}</p>
      <p class="mt-0.5 truncate text-xs text-dimmed">{prompt.origin}</p>
    </div>

    <div class="flex flex-col">
      {#each sections as section (section.id)}
        <section class="border-b border-border last:border-b-0">
          <h3 class="px-6 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted">
            {section.label}
          </h3>
          <ul class="flex flex-col pb-2">
            {#each section.entries as descriptor (descriptor.id)}
              <li class="flex items-center gap-4 px-6 py-2">
                <span class="min-w-0 flex-1">
                  <span class="block text-sm text-foreground">{descriptor.label}</span>
                  <span class="mt-0.5 block text-xs leading-relaxed text-dimmed">
                    {descriptor.description}
                  </span>
                </span>
                <div class="w-48 shrink-0">
                  <EnumSelect
                    inline
                    options={STATE_OPTIONS}
                    value={stateFor(descriptor.id)}
                    onChange={(action) => choose(descriptor.id, action)}
                    placeholder="Ask"
                    ariaLabel={`${descriptor.label} permission`}
                    title={`${descriptor.label}: ask, allow or block`}
                  />
                </div>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="flex h-8 items-center rounded-lg bg-primary px-4 text-xs font-semibold text-on-primary transition-colors hover:bg-primary-hover"
      onclick={() => globalBrowser.dismissSitePermissions()}
    >
      Done
    </button>
  {/snippet}
</Modal>
