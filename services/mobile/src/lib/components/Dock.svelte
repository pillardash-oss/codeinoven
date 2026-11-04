<script lang="ts">
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import CioChat from '@pdslng/cio-icon/CioChat.svelte'
  import CioProjects from '@pdslng/cio-icon/CioProjects.svelte'
  import CioSparkles from '@pdslng/cio-icon/CioSparkles.svelte'
  import CioThreads from '@pdslng/cio-icon/CioThreads.svelte'

  /**
   * The dock is navigation, and the project and the threads it contains are one
   * destination: a phone has no second column, so one square switches between the
   * list of threads and the list of projects instead of spending two squares on
   * the same work.
   */
  interface Props {
    projectsOpen: boolean
    onprojects: () => void
  }

  let { projectsOpen, onprojects }: Props = $props()

  let path = $derived(page.url.pathname)
  let onWork = $derived(path === '/' || path === '/threads')
  let onChats = $derived(path.startsWith('/chats'))
  let onAssistant = $derived(path.startsWith('/assistant'))
  let menuOpen = $state(false)

  function chooseProjects(): void {
    menuOpen = false
    onprojects()
  }

  function chooseThreads(): void {
    menuOpen = false
    void goto('/threads')
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    const target = event.target
    if (target instanceof Element && target.closest('.dock, .dockmenu')) return
    menuOpen = false
  }}
/>

{#if menuOpen}
  <div class="dockmenu" role="menu" aria-label="Project or threads">
    <button class="dockmenu-item" type="button" role="menuitem" onclick={chooseThreads}>
      <CioThreads size={16} />
      <span>Threads</span>
      {#if onWork}<span class="here">✓</span>{/if}
    </button>
    <button class="dockmenu-item" type="button" role="menuitem" onclick={chooseProjects}>
      <CioProjects size={16} />
      <span>Projects</span>
      {#if projectsOpen}<span class="here">✓</span>{/if}
    </button>
  </div>
{/if}

<nav class="dock" aria-label="Panels">
  <button
    class="dockitem"
    type="button"
    aria-expanded={menuOpen}
    aria-haspopup="menu"
    aria-label={onWork ? undefined : 'Projects and threads'}
    title={onWork ? undefined : 'Projects and threads'}
    onclick={() => (menuOpen = !menuOpen)}
  >
    {#if onWork}
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
