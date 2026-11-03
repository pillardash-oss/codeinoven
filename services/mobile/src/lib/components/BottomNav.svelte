<script lang="ts">
  import CioProjects from '@pdslng/cio-icon/CioProjects.svelte'
  import CioThreads from '@pdslng/cio-icon/CioThreads.svelte'
  import CioSparkles from '@pdslng/cio-icon/CioSparkles.svelte'
  import CioTabSettings from '@pdslng/cio-icon/CioTabSettings.svelte'
  import { page } from '$app/state'

  /**
   * The app's primary navigation. Four destinations, because the phone reads and
   * prompts: projects, the threads inside them, the assistants that run on their
   * own, and the account that signs this device in.
   */
  const items = [
    { href: '/', label: 'Projects', icon: CioProjects },
    { href: '/threads', label: 'Threads', icon: CioThreads },
    { href: '/assistant', label: 'Assistant', icon: CioSparkles },
    { href: '/account', label: 'Account', icon: CioTabSettings }
  ]

  function current(href: string): boolean {
    const path = page.url.pathname
    if (href === '/') return path === '/'
    return path === href || path.startsWith(`${href}/`)
  }
</script>

<nav class="nav" aria-label="Primary">
  {#each items as item (item.href)}
    <a class="navitem" href={item.href} aria-current={current(item.href) ? 'page' : undefined}>
      <item.icon size={20} />
      {item.label}
    </a>
  {/each}
</nav>
