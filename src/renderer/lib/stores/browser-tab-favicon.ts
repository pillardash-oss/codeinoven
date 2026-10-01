import { isStorableBrowserFavicon } from '$shared/browser/global-browser-tabs'
import { faviconState } from './favicons.svelte'

/**
 * The part of a tab an icon resolver reads: its identity, the address it is
 * showing, and the icon it holds.
 *
 * Both tab lists carry these fields, which is what lets one resolver serve the
 * global browser's strip and the sidebar's per-project browser instead of each
 * one growing its own copy of the rule.
 */
export interface FaviconTab {
  id: string
  url: string
  favicon: string | null
}

/**
 * Filling in the icon of a tab the app has never watched a page for.
 *
 * A tab's icon belongs to its address, not to the running page, and the app has
 * two sources for it. The page is the first: it reports the icon it uses, and the
 * browser service hands that on as a data URL. The site itself is the second, and
 * this is it: the address is asked for the icon it is known by, through the same
 * resolver every link, avatar and saved page in the app goes through.
 *
 * The second source is what keeps a row wearing a mark when there is no page to
 * report one. A tab restored by a restart, a tab hibernated before its page ever
 * announced an icon, and a tab an agent opened without showing it all have an
 * address and no live document, and a globe in place of the site's mark is exactly
 * the state this removes. The strip writes the answer down with the tab, so the
 * next launch has it before any page loads, and a saved page copies it when the
 * tab is bookmarked.
 *
 * The bookkeeping is what makes this bounded. One address is asked about at most
 * once per tab: the shared favicon cache behind `faviconState` already dedupes by
 * host, and a strip that re-renders on every page-state report would otherwise ask
 * again on each one. A host that answered nothing is remembered as having
 * answered, so a site with no icon costs one lookup rather than one per render.
 */
export class BrowserTabFavicons {
  /**
   * The address each tab's icon was last asked about, keyed by tab id. An entry
   * is replaced when the tab navigates, so the map is bounded by the tabs that
   * exist rather than by the pages they visited.
   */
  private readonly asked = new Map<string, string>()

  /**
   * The icon the address of one tab is known by, or null when there is nothing to
   * fill in.
   *
   * Answers null when the tab already holds an icon, has no address to ask about,
   * or has been asked about this address already. `read` is called twice on
   * purpose: once for the address to ask about, and again after the answer lands,
   * because a tab can navigate while the lookup is in flight and an icon for the
   * page it left behind belongs to that page.
   */
  async resolve(tabId: string, read: () => FaviconTab | null): Promise<string | null> {
    const tab = read()
    if (!tab || tab.url === '' || tab.favicon !== null) return null
    if (this.asked.get(tabId) === tab.url) return null
    this.asked.set(tabId, tab.url)
    const url = tab.url
    const resolved = await faviconState.resolve(url)
    const current = read()
    if (!current || current.url !== url) return null
    return isStorableBrowserFavicon(resolved) ? resolved : null
  }

  /** Drop a closed tab's bookkeeping, so a long session does not remember every
   *  tab it ever held. */
  forget(tabId: string): void {
    this.asked.delete(tabId)
  }
}
