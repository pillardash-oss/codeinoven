/**
 * The mark an agent's own action leaves on the page.
 *
 * It is a node in the page rather than a hint in the app, so a screenshot shows
 * where the agent is working and the person watching sees the same thing the model
 * does. It carries the agent's own attribute, so no snapshot ever mistakes it for
 * page content and no action ever resolves it as the thing to click.
 */

import { type AgentCursorAppearance } from '../../../../lib/browser/agent-cursor'
import { AGENT_OWNED_ATTRIBUTE } from './page-toolkit'

/**
 * Move the agent's own mark to a point.
 *
 * The mark is a cursor rather than a reticle: a solid gold blade whose tip is the
 * point the action touched, notched at the back so it never reads as a pin. A game's
 * cursor is the reference, because that is the one place a pointer is unmistakably an
 * instrument, and it points rather than tracks, which is what an action does.
 *
 * It is completely static. There is no rotation, no pulse and no keyframes, so a page
 * with the agent on it costs exactly one node and its inline styles: nothing runs
 * while the app waits for the next action.
 *
 * Contrast is structural, not hopeful: the gold body sits in an obsidian edge, so the
 * mark separates from a white page, a near-black one, and a page painted the accent's
 * own gold. It is drawn as a node of its own, so a screenshot shows it and no
 * snapshot mistakes it for page content.
 */
export function agentCursorScript(request: {
  x: number
  y: number
  hide: boolean
  appearance: AgentCursorAppearance
}): string {
  return `(() => {
    const MARK_ATTR = ${JSON.stringify(AGENT_OWNED_ATTRIBUTE)};
    const HOST_ID = '__cio-agent-cursor';
    const APPEARANCE = ${JSON.stringify(request.appearance)};
    const appearanceKey = JSON.stringify(APPEARANCE);
    const existing = document.getElementById(HOST_ID);
    if (${request.hide ? 'true' : 'false'}) {
      if (existing) existing.remove();
      globalThis.__cioAgentCursor = null;
      return { cursor: false };
    }
    let record = globalThis.__cioAgentCursor;
    // A mark drawn before the theme, contrast level or UI scale changed carries the
    // old colours or size, so it is redrawn rather than moved.
    if (
      !record ||
      !existing ||
      existing.getAttribute(MARK_ATTR) !== 'cursor' ||
      record.appearanceKey !== appearanceKey
    ) {
      if (existing) existing.remove();
      const { stroke, accent, scale } = APPEARANCE;
      // The blade's own box, in units, with its tip on the hotspot so the point the
      // action touched is the point that is drawn.
      const LEFT = -20;
      const TIP = -3;
      const host = document.createElement('div');
      host.id = HOST_ID;
      host.setAttribute(MARK_ATTR, 'cursor');
      host.setAttribute('aria-hidden', 'true');
      // \`all:initial\` first: the mark sits inside a stranger's document, and a page
      // rule that gives every svg a margin, a line height or a fill would otherwise
      // move or recolour it. Inline declarations win over the page's own rules, so the
      // mark is drawn where the action happened on any page rather than on a polite one.
      host.style.cssText =
        'all:initial;display:block;position:fixed;left:0;top:0;width:0;height:0;margin:0;padding:0;' +
        'z-index:2147483647;pointer-events:none;transition:left 90ms linear,top 90ms linear;';
      const svgNs = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNs, 'svg');
      svg.setAttribute('width', String(40 * scale));
      svg.setAttribute('height', String(40 * scale));
      svg.setAttribute('viewBox', '0 0 40 40');
      svg.style.cssText =
        'all:initial;display:block;position:absolute;left:' + LEFT * scale + 'px;top:' + TIP * scale + 'px;' +
        'margin:0;padding:0;overflow:visible;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5));';
      const blade = document.createElementNS(svgNs, 'path');
      blade.setAttribute('d', 'M20 3 L33.5 34 L20 27 L6.5 34 Z');
      blade.style.cssText =
        'fill:' + accent + ';stroke:' + stroke + ';stroke-width:1.6;stroke-linejoin:miter;';
      svg.appendChild(blade);
      host.appendChild(svg);
      (document.body || document.documentElement).appendChild(host);
      record = { host, svg, appearanceKey };
      globalThis.__cioAgentCursor = record;
    }
    record.host.style.left = ${JSON.stringify(request.x)} + 'px';
    record.host.style.top = ${JSON.stringify(request.y)} + 'px';
    return { cursor: true, x: ${JSON.stringify(request.x)}, y: ${JSON.stringify(request.y)} };
  })()`
}
