<script lang="ts">
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import CioChat from '@pdslng/cio-icon/CioChat.svelte'
  import CioProjects from '@pdslng/cio-icon/CioProjects.svelte'
  import CioSparkles from '@pdslng/cio-icon/CioSparkles.svelte'
  import CioThreads from '@pdslng/cio-icon/CioThreads.svelte'
  import { readWorkView, workViewHref } from '#lib/work-view'

  /**
   * The dock is navigation, and the project and the threads it contains are one
   * destination: a phone has no second column, so one square opens the work list
   * instead of spending two squares on the same work. That square opens whichever
   * reading of the list was used last, and which reading that is gets chosen in
   * the list's own header, never here.
   */
  let path = $derived(page.url.pathname)
  let onWork = $derived(path === '/' || path === '/threads' || path === '/projects')
  let onProjects = $derived(path === '/projects')
  let onChats = $derived(path.startsWith('/chats'))
  let onAssistant = $derived(path.startsWith('/assistant'))

  async function openWork(): Promise<void> {
    await goto(workViewHref(await readWorkView()))
  }
</script>

<nav class="dock" aria-label="Panels">
  <button
    class="dockitem"
    type="button"
    aria-current={onWork ? 'page' : undefined}
    aria-label={onWork ? undefined : 'Threads and projects'}
    title={onWork ? undefined : 'Threads and projects'}
    onclick={() => void openWork()}
  >
    {#if onProjects}
      <CioProjects size={18} />
      <span>Projects</span>
    {:else if onWork}
      <CioThreads size={18} />
      <span>Threads</span>
    {:else}
      <CioProjects size={18} />
    {/if}
  </button>

  <a
    class="dockitem"
    href="/chats"
    aria-current={onChats ? 'page' : undefined}
    aria-label={onChats ? undefined : 'Chats'}
    title={onChats ? undefined : 'Chats'}
  >
    <CioChat size={18} />
    {#if onChats}<span>Chats</span>{/if}
  </a>

  <a
    class="dockitem"
    href="/assistant"
    aria-current={onAssistant ? 'page' : undefined}
    aria-label={onAssistant ? undefined : 'Assistant'}
    title={onAssistant ? undefined : 'Assistant'}
  >
    <CioSparkles size={18} />
    {#if onAssistant}<span>Assistant</span>{/if}
  </a>
</nav>
