<script lang="ts">
  import { Boxes, Check, ChevronDown, Globe } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import type { GlobalBrowserBox } from '$lib/stores/global-browser-types'
  import { browserAppearanceAccent, browserAppearanceIconUrl } from './browser-group-appearance'

  /**
   * The thread browser's box control.
   *
   * A box is a named cookie jar, so this is where a conversation says whose
   * sign-ins its pages run against. Every conversation starts in its own scope's
   * jar   a project's box, a routine's box, a chat's box   and the control names
   * that as the default. Picking one of the profile's shared boxes lets the agent
   * reuse the sign-ins the user already has in the global browser, which is the
   * whole point of the control.
   *
   * The choice is a reopen rather than a move: a tab cannot change jars in place,
   * so the tab on screen is replaced by an equivalent one in the chosen box and
   * later tabs follow it. The store owns which box that is, so this component
   * only renders the current answer and reports the pick.
   */

  interface Props {
    projectId: string
    threadId: string
    /** The box the tab on screen runs in, or null for the scope's own jar. */
    boxId: string | null
    /** Name the current box beside the icon, which the full screen toolbar has room for. */
    labelled?: boolean
    onChange: (boxId: string | null) => void
  }

  let { projectId, threadId, boxId, labelled = false, onChange }: Props = $props()

  const scopeLabel = $derived(contextSidebarState.browserScopeBoxLabel(projectId, threadId))
  const boxes = $derived(globalBrowser.boxes)
  const current = $derived(boxId ? globalBrowser.boxById(boxId) : null)
  const currentName = $derived(current?.name ?? scopeLabel)
  const currentAccent = $derived(current ? browserAppearanceAccent(current) : null)

  const itemClass =
    'flex cursor-pointer items-start gap-2 rounded-md px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated'

  function boxIconUrl(box: GlobalBrowserBox): string | null {
    return browserAppearanceIconUrl(box, globalBrowser.boxIconUrl(box.id))
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class={[
      'relative flex h-7 shrink-0 items-center justify-center rounded-md transition-colors',
      labelled ? 'gap-1.5 px-2 text-[0.6875rem] font-medium' : 'w-7',
      'text-dimmed hover:bg-elevated hover:text-foreground'
    ]}
    aria-label={`Box: ${currentName}. Choose which box this tab and new tabs use`}
    title={`Box: ${currentName}`}
  >
    <Boxes size={13} style={currentAccent ? `color: ${currentAccent}` : undefined} />
    {#if labelled}
      <span class="max-w-32 truncate">{currentName}</span>
      <ChevronDown size={12} />
    {/if}
  </DropdownMenu.Trigger>

  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={6}
      class="z-60 max-h-[calc(100vh-1.5rem)] w-64 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg"
    >
      <DropdownMenu.Item class={itemClass} textValue={scopeLabel} onSelect={() => onChange(null)}>
        <Globe size={13} class="mt-0.5 shrink-0 text-muted" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-xs font-medium text-foreground">{scopeLabel}</span>
          <span class="mt-0.5 block text-[0.625rem] leading-relaxed text-dimmed">
            This conversation's own sign-ins
          </span>
        </span>
        {#if boxId === null}
          <Check size={12} class="mt-0.5 shrink-0 text-primary" />
        {/if}
      </DropdownMenu.Item>

      {#if boxes.length > 0}
        <DropdownMenu.Separator class="my-1 h-px bg-border" />
        {#each boxes as box (box.id)}
          {@const url = boxIconUrl(box)}
          <DropdownMenu.Item
            class={itemClass}
            textValue={box.name}
            onSelect={() => onChange(box.id)}
          >
            {#if url}
              <img src={url} alt="" class="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-sm object-contain" />
            {:else}
              <span
                class="mt-1 h-2 w-2 shrink-0 rounded-full"
                style="background-color: {browserAppearanceAccent(box)}"
              ></span>
            {/if}
            <span class="min-w-0 flex-1">
              <span class="block truncate text-xs font-medium text-foreground">{box.name}</span>
              <span class="mt-0.5 block text-[0.625rem] leading-relaxed text-dimmed">
                Shared with the global browser
              </span>
            </span>
            {#if box.id === boxId}
              <Check size={12} class="mt-0.5 shrink-0 text-primary" />
            {/if}
          </DropdownMenu.Item>
        {/each}
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
