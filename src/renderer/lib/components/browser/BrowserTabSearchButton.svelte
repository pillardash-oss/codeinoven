<script lang="ts">
  import SidebarSearchControl from '../workspace/SidebarSearchControl.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'

  const group = $derived(
    globalBrowser.tabSearchGroupId ? globalBrowser.groupById(globalBrowser.tabSearchGroupId) : null
  )
</script>

{#key globalBrowser.tabSearchFocusRequest}
  <SidebarSearchControl
    open={globalBrowser.tabSearchOpen}
    query={globalBrowser.tabSearchQuery}
    onOpenChange={(open) => {
      if (open) globalBrowser.openTabSearch()
      else globalBrowser.closeTabSearch()
    }}
    onQueryChange={(query) => globalBrowser.setTabSearchQuery(query)}
    ariaLabel={group ? `Search tabs in ${group.name}` : 'Search browser tabs'}
    title="Search tabs"
    placeholder={group ? `Search in ${group.name}` : 'Search tabs'}
    size="md"
  />
{/key}
