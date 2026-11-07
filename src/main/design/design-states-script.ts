import { ELEMENT_PATH_SOURCE } from '../dom/element-path-script'
import { MAX_DISCOVERED_STATES_PER_SCREEN } from '../../lib/design/screen-canvas'

/**
 * What a screen says about its own states, read from its live DOM.
 *
 * A design's states are not files: a dialog is up, a menu is expanded, a popover
 * is open. The canvas draws them by clicking the trigger inside the frame, so the
 * only thing discovery has to produce is the selector of each trigger that opens
 * something. Nothing is clicked here: the enumeration is a read, which is what
 * makes it cheap enough to run for every screen of a design and safe enough to
 * run against a page the user is not watching.
 *
 * A trigger is only accepted when the screen declares it. That is the whole policy:
 * the app clicks what the markup says is a disclosure or an overlay control, and
 * never guesses that an ordinary button might open something. `aria-expanded`,
 * `aria-haspopup`, `aria-controls` and `popover` are the declaration, the element
 * has to be something a person can actually press, and one already expanded is the
 * state the screen is written in rather than a state to reach.
 *
 * Kept out of the window-owning module so the contract can be exercised on a
 * document without Electron.
 */
export function designStatesScript(limit = MAX_DISCOVERED_STATES_PER_SCREEN): string {
  const config = JSON.stringify({ limit })
  return String.raw`(() => {
  const config = ${config};
  ${ELEMENT_PATH_SOURCE}
  const INTERACTIVE =
    'button,a[href^="#"],a[href=""],[role="button"],[role="menuitem"],[role="tab"],summary,[tabindex]:not([tabindex="-1"])';
  const DECLARED = '[aria-expanded],[aria-haspopup],[aria-controls],[popover],[data-state]';
  const labelOf = (element) => {
    const aria = element.getAttribute('aria-label');
    if (aria) return aria.trim().slice(0, 80);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = [];
      for (const id of labelledBy.split(/\s+/)) {
        const node = id ? document.getElementById(id) : null;
        if (node && node.textContent) parts.push(node.textContent);
      }
      const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (joined) return joined.slice(0, 80);
    }
    const own = (element.textContent || '').replace(/\s+/g, ' ').trim();
    if (own) return own.slice(0, 80);
    const title = element.getAttribute('title');
    return title ? title.trim().slice(0, 80) : '';
  };
  const found = [];
  const seen = {};
  const candidates = document.querySelectorAll(DECLARED);
  for (let index = 0; index < candidates.length; index += 1) {
    if (found.length >= config.limit) break;
    const element = candidates[index];
    if (!element.matches(INTERACTIVE)) continue;
    if (element.disabled) continue;
    if (element.getAttribute('aria-expanded') === 'true') continue;
    if (element.closest('[hidden],[inert],[aria-hidden="true"]')) continue;
    const click = elementPath(element);
    if (!click || seen[click]) continue;
    seen[click] = true;
    found.push({ click: click, title: labelOf(element) || null });
  }
  return found;
})()`
}
