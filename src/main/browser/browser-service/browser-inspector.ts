/**
 * Element inspector for the embedded browser.
 *
 * A browser page is a native `WebContentsView` composited ABOVE every DOM
 * surface of the renderer, so nothing the app draws can sit on the page. The
 * Chrome-style inspect affordance therefore lives in the page: this observer
 * injects an idempotent script into the document under a random per-tab global
 * name, exactly the way `browser-capture.ts` does, and that script draws the
 * hover box, the label, the numbered pins, the persistent outline on every
 * commented element and the comment card, and reports picks and comment text
 * back.
 *
 * The comment card is drawn here, in the page, and not by the app, for the same
 * reason the pins are: nothing the app draws can sit on the page. It is built
 * from the app's own theme tokens, so it reads as the same comment card the app
 * opens over a selection, and it is draggable at its header, so a card covering
 * the element it belongs to can be moved off it. The page reports the text and
 * the renderer owns it; the page never stores a comment of its own.
 *
 * The overlay is themed with the application's own design tokens, which main
 * hands over with the arm command and re-sends when the theme changes: injected
 * script cannot read the app's stylesheet, and a hardcoded light box on a dark
 * application is exactly the bug that push exists to prevent.
 *
 * The channel is the same one the capture observer uses, and for the same
 * reason: the embedded browser deliberately gives remote content no preload
 * script (`docs/EMBEDDED_BROWSER_ARCHITECTURE.md`), so `executeJavaScript` in
 * the frame's own world is the one boundary that runs page code. `wait()`
 * returns a promise that resolves with the next event and main re-arms it after
 * every answer: no interval, no polling, no console channel, and no bridge from
 * page script back to privileged APIs.
 *
 * Commands travel the other way as their own `executeJavaScript` calls, so a
 * marker set or a focus change costs one evaluation and never blocks the
 * pending event.
 */

import type { WebContents } from 'electron'
import type {
  BrowserInspectorEvent,
  BrowserInspectorMarker,
  BrowserInspectorTheme
} from '../../../lib/ipc/browser'
import { Logger } from '../../system/logger'
import {
  INSPECTOR_REARM_INTERVAL_MS,
  MAX_INSPECTOR_ARM_FAILURES,
  MAX_INSPECTOR_MARKERS
} from './browser-validation'

/** Longest text a pick carries for the model, in characters. */
export const MAX_INSPECTOR_TEXT = 400
/** Longest opening markup a pick carries, in characters. */
export const MAX_INSPECTOR_HTML = 600
/** Most ancestors a breadcrumb carries. */
export const MAX_INSPECTOR_ANCESTORS = 6

export interface BrowserInspectorDeps {
  /** Called for every event the injected inspector reports. */
  onEvent: (tabId: string, event: BrowserInspectorEvent) => void
}

interface ObservedTab {
  contents: WebContents
  key: string
  /** Whether the renderer wants inspect mode on. Kept across a navigation, so a
   *  live-preview reload does not silently drop the user out of inspection. */
  desiredArmed: boolean
  /** True while an event promise is outstanding, so a duplicate arm cannot
   *  stack a second waiter on the same tab. */
  pending: boolean
  /** Bumped by every document swap. An answer owed by a document that has
   *  ended is discarded rather than delivered as if it belonged to the current
   *  one, which is what keeps a reload from reporting a stale pick. */
  generation: number
  failures: number
  /** Last marker set the renderer published, re-applied to every new document. */
  markers: BrowserInspectorMarker[]
  /** Last theme the application published, re-applied to every new document so a
   *  reloaded overlay is never briefly drawn with the wrong colours. */
  theme: BrowserInspectorTheme | null
  /** Last element the app asked to highlight, replayed after the pins exist. A
   *  focus can arrive before the marker set it names, so it is remembered rather
   *  than dropped. */
  focus: { id: string | null; scroll: boolean } | null
}

/**
 * The page-side inspector, installed once per document.
 *
 * Everything inside builds its own DOM inside a closed shadow root attached to
 * `<html>`, so the design's own stylesheet cannot restyle it and its layout
 * cannot be read by the design. The script names its global after a random
 * per-tab key, so page script cannot guess the object it would have to forge to
 * fake a pick, and it is idempotent: a second install in the same document
 * returns the existing object rather than stacking a second overlay.
 *
 * Exported alongside the two other evaluations so the page-side contract can be
 * exercised without Electron, in the same spirit as `captureObserverScript`.
 */
export function inspectorInstallScript(key: string): string {
  const config = JSON.stringify({
    key,
    maxText: MAX_INSPECTOR_TEXT,
    maxHtml: MAX_INSPECTOR_HTML,
    maxAncestors: MAX_INSPECTOR_ANCESTORS,
    maxMarkers: MAX_INSPECTOR_MARKERS
  })
  return String.raw`(() => {
  const config = ${config};
  try {
    if (globalThis[config.key]) return true;
    if (!document.documentElement) return false;

    const CSS = [
      ':host{all:initial}',
      '.cio-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483646}',
      '.cio-box{position:fixed;box-sizing:border-box;border-radius:2px;pointer-events:none}',
      '.cio-hover{background:color-mix(in srgb,var(--cio-accent,#d4af37) 18%,transparent);outline:1px solid var(--cio-accent,#d4af37)}',
      '.cio-marked{position:fixed;box-sizing:border-box;border-radius:3px;pointer-events:none;outline:1px solid color-mix(in srgb,var(--cio-accent,#d4af37) 50%,transparent);transition:background-color .12s ease,outline-color .12s ease}',
      '.cio-marked[data-hover="1"]{background:color-mix(in srgb,var(--cio-accent,#d4af37) 14%,transparent);outline:2px solid var(--cio-accent,#d4af37)}',
      '.cio-marked[data-active="1"]{background:color-mix(in srgb,var(--cio-accent,#d4af37) 10%,transparent);outline:2px solid var(--cio-accent,#d4af37)}',
      '.cio-label{position:fixed;pointer-events:none;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 6px;border-radius:5px;background:var(--cio-foreground,#081825);color:var(--cio-surface,#ffffff);font:500 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 2px 8px rgba(0,0,0,.35)}',
      '.cio-label .d{opacity:.72}',
      '.cio-pin{position:fixed;pointer-events:auto;cursor:pointer;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:999px;border:1px solid var(--cio-foreground,#081825);background:var(--cio-surface,#ffffff);color:var(--cio-foreground,#081825);font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.28);transition:border-color .12s ease,color .12s ease}',
      '.cio-pin svg{width:12px;height:12px;flex:none}',
      '.cio-pin[data-comment="1"]{border-color:var(--cio-accent,#d4af37);color:var(--cio-accent,#d4af37)}',
      '.cio-pin[data-active="1"]{outline:2px solid var(--cio-accent,#d4af37);outline-offset:1px}',
      '.cio-card{position:fixed;pointer-events:auto;width:340px;max-width:calc(100vw - 16px);border-radius:12px;border:1px solid var(--cio-border,#d4d4d8);background:var(--cio-surface,#ffffff);color:var(--cio-foreground,#081825);box-shadow:0 14px 36px rgba(0,0,0,.3);font:400 12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}',
      '.cio-card[hidden]{display:none}',
      '.cio-card-head{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:grab;user-select:none;border-bottom:1px solid var(--cio-border,#e4e4e7)}',
      '.cio-card-head:active{cursor:grabbing}',
      '.cio-card-dot{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:none;border-radius:999px;background:color-mix(in srgb,var(--cio-accent,#d4af37) 18%,transparent);color:var(--cio-accent,#d4af37);font:600 10px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.cio-card-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:11px}',
      '.cio-card-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--cio-muted,#71717a);cursor:pointer}',
      '.cio-card-close:hover{background:var(--cio-elevated,#f4f4f5);color:var(--cio-foreground,#081825)}',
      '.cio-card-close svg{width:13px;height:13px}',
      '.cio-card-body{padding:10px}',
      '.cio-card textarea{display:block;width:100%;box-sizing:border-box;min-height:72px;resize:vertical;border-radius:8px;border:1px solid var(--cio-border,#e4e4e7);background:var(--cio-elevated,#f4f4f5);color:var(--cio-foreground,#081825);padding:8px 10px;font:inherit;outline:none}',
      '.cio-card textarea::placeholder{color:var(--cio-muted,#a1a1aa)}',
      '.cio-card-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}',
      '.cio-card-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:0;border-radius:8px;cursor:pointer;font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.cio-card-btn svg{width:12px;height:12px}',
      '.cio-card-remove{background:transparent;color:var(--cio-muted,#71717a)}',
      '.cio-card-remove:hover{background:color-mix(in srgb,#ef4444 12%,transparent);color:#ef4444}',
      '.cio-card-remove:disabled{opacity:.4;cursor:default}',
      '.cio-card-done{background:var(--cio-foreground,#081825);color:var(--cio-surface,#ffffff)}'
    ].join('');

    const host = document.createElement('div');
    host.setAttribute('data-cio-inspector', '');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    const layer = document.createElement('div');
    layer.className = 'cio-layer';
    root.appendChild(layer);
    document.documentElement.appendChild(host);

    const hoverBox = document.createElement('div');
    hoverBox.className = 'cio-box cio-hover';
    hoverBox.style.display = 'none';
    const labelEl = document.createElement('div');
    labelEl.className = 'cio-label';
    labelEl.style.display = 'none';
    layer.appendChild(hoverBox);
    layer.appendChild(labelEl);

    const state = {
      armed: false,
      hovered: null,
      activeId: null,
      hoverId: null,
      markers: new Map(),
      waiters: [],
      queued: [],
      scanTimer: 0,
      hoverFrame: 0,
      listeners: false,
      drag: null,
      draftTimer: 0
    };

    // Lucide's message-circle icon, the same one the app draws a comment pin
    // with (ResponseAnnotationBubble.svelte), inlined as path data: the page
    // overlay cannot import the icon library, and an icon is not an emoji.
    const PIN_ICON =
      'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719';
    const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const text = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
    const escapeId = (value) => (globalThis.CSS && CSS.escape ? CSS.escape(String(value)) : String(value));

    function applyTheme(tokens) {
      if (!tokens || typeof tokens !== 'object') return;
      for (const name of ['surface', 'elevated', 'border', 'foreground', 'muted', 'accent']) {
        const value = tokens[name];
        if (typeof value === 'string' && value) layer.style.setProperty('--cio-' + name, value);
      }
    }

    function pinIcon() {
      const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(SVG_NAMESPACE, 'path');
      path.setAttribute('d', PIN_ICON);
      svg.appendChild(path);
      return svg;
    }

    function cssPath(element) {
      const parts = [];
      let node = element;
      while (node && node.nodeType === 1 && parts.length < 8) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          const id = escapeId(node.id);
          try {
            if (document.querySelectorAll('#' + id).length === 1) {
              parts.unshift(part + '#' + id);
              break;
            }
          } catch (error) {}
          part += '#' + id;
        }
        const classes = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (classes.length > 0) part += '.' + classes.map(escapeId).join('.');
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.prototype.filter.call(parent.children, (child) => child.tagName === node.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(' > ');
    }

    function shortName(element) {
      let name = element.tagName.toLowerCase();
      if (element.id) name += '#' + element.id;
      const classes = (element.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
      if (classes.length > 0) name += '.' + classes.slice(0, 2).join('.');
      return name;
    }

    function describe(element) {
      const rect = element.getBoundingClientRect();
      const ancestors = [];
      let parent = element.parentElement;
      while (parent && parent !== document.documentElement && ancestors.length < config.maxAncestors) {
        ancestors.unshift(shortName(parent));
        parent = parent.parentElement;
      }
      return {
        selector: cssPath(element),
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        classes: (element.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 12),
        role: element.getAttribute('role'),
        text: text(element.innerText || element.textContent, config.maxText),
        html: text(element.outerHTML, config.maxHtml),
        ancestors: ancestors,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    }

    function resolveElement(marker) {
      if (marker.element && marker.element.isConnected) return marker.element;
      if (!marker.selector) return null;
      try {
        const found = document.querySelector(marker.selector);
        if (found) marker.element = found;
        return found;
      } catch (error) {
        return null;
      }
    }

    function emit(event) {
      const resolve = state.waiters.shift();
      if (resolve) resolve(event);
      else if (state.queued.length < 32) state.queued.push(event);
    }

    function place(element, box) {
      const rect = element.getBoundingClientRect();
      box.style.left = rect.x + 'px';
      box.style.top = rect.y + 'px';
      box.style.width = Math.max(0, rect.width) + 'px';
      box.style.height = Math.max(0, rect.height) + 'px';
      box.style.display = 'block';
    }

    function renderLabel(element) {
      const rect = element.getBoundingClientRect();
      labelEl.textContent = '';
      const name = document.createElement('span');
      name.textContent = shortName(element);
      const size = document.createElement('span');
      size.className = 'd';
      size.textContent = '  ' + Math.round(rect.width) + 'x' + Math.round(rect.height);
      labelEl.appendChild(name);
      labelEl.appendChild(size);
      labelEl.style.display = 'block';
      labelEl.style.left = clamp(rect.x, 4, Math.max(4, innerWidth - 40)) + 'px';
      const above = rect.y - labelEl.offsetHeight - 4;
      labelEl.style.top = (above > 4 ? above : rect.y + 4) + 'px';
    }

    function onScreen(rect) {
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth
      );
    }

    function positionCard(marker) {
      const card = marker.card;
      if (!card || card.hidden) return;
      if (marker.cardPos) {
        card.style.left = marker.cardPos.left + 'px';
        card.style.top = marker.cardPos.top + 'px';
        return;
      }
      const element = resolveElement(marker);
      const rect = element ? element.getBoundingClientRect() : null;
      const width = card.offsetWidth || 340;
      const height = card.offsetHeight || 200;
      let left = 8;
      let top = 8;
      if (rect) {
        left = clamp(rect.x, 8, Math.max(8, innerWidth - width - 8));
        top = rect.bottom + 8;
        if (top + height > innerHeight - 8) top = Math.max(8, rect.y - height - 8);
      }
      card.style.left = left + 'px';
      card.style.top = top + 'px';
    }

    function layout() {
      for (const marker of state.markers.values()) {
        const element = resolveElement(marker);
        const active = state.activeId === marker.id;
        const hovered = state.hoverId === marker.id;
        marker.box.setAttribute('data-active', active ? '1' : '0');
        marker.box.setAttribute('data-hover', hovered ? '1' : '0');
        marker.pin.setAttribute('data-active', active ? '1' : '0');
        if (!element) {
          marker.box.style.display = 'none';
          marker.pin.style.display = 'none';
          continue;
        }
        const rect = element.getBoundingClientRect();
        const shown = onScreen(rect);
        place(element, marker.box);
        marker.box.style.display = shown ? 'block' : 'none';
        // A pin belongs to the part of the page its element is in: it is drawn
        // at the element and hidden once that part is off screen, rather than
        // being clamped to the viewport edge for something the reader cannot
        // see. Sticky header offsets are left alone, because a pin that follows
        // its element is the point.
        if (shown) {
          marker.pin.style.display = 'inline-flex';
          marker.pin.style.left = clamp(rect.x, 2, Math.max(2, innerWidth - 52)) + 'px';
          marker.pin.style.top = clamp(rect.y - 26, 2, Math.max(2, innerHeight - 26)) + 'px';
        } else {
          marker.pin.style.display = 'none';
        }
      }
      const active = state.activeId ? state.markers.get(state.activeId) : null;
      if (active && active.card && !active.card.hidden) positionCard(active);
    }

    function syncCursor() {
      if (!state.armed) {
        hoverBox.style.display = 'none';
        labelEl.style.display = 'none';
        return;
      }
      const element = state.hovered;
      if (!element || !element.isConnected) {
        hoverBox.style.display = 'none';
        labelEl.style.display = 'none';
        return;
      }
      place(element, hoverBox);
      renderLabel(element);
    }

    function ourNode(event) {
      const path = event.composedPath ? event.composedPath() : [];
      for (const node of path) if (node === host || (node && node.host === host)) return true;
      return false;
    }

    function markerForHover(element) {
      for (const marker of state.markers.values()) {
        const node = resolveElement(marker);
        if (node && (node === element || node.contains(element))) return marker;
      }
      return null;
    }

    function scheduleHoverFrame() {
      if (state.hoverFrame) return;
      state.hoverFrame = requestAnimationFrame(() => {
        state.hoverFrame = 0;
        syncCursor();
        layout();
      });
    }

    function onPointerMove(event) {
      if (ourNode(event)) return;
      const element = event.target instanceof Element ? event.target : null;
      const hover = element ? markerForHover(element) : null;
      const hoverId = hover ? hover.id : null;
      const markerChanged = state.hoverId !== hoverId;
      state.hoverId = hoverId;
      if (state.armed) {
        const elementChanged = element !== state.hovered;
        state.hovered = element;
        if (elementChanged || markerChanged) scheduleHoverFrame();
        return;
      }
      // A commented element that is hovered lights up like a commented range in
      // the conversation, whether or not picking is armed: the pins outlive
      // inspect mode, and their elements have to answer the pointer with them.
      if (markerChanged) scheduleHoverFrame();
    }

    /**
     * The marker already covering an element, or null when it has none.
     *
     * Identity comes first, because the same live node is unambiguously the
     * same element. A node that was re-rendered is a different node with the
     * same place, so its CSS path is compared as well, and only when that path
     * resolves to exactly one element: a path inside a list matches every row,
     * and treating those as one element would merge comments on distinct ones.
     * That is what keeps a second click on one element an edit of its single
     * comment instead of a second comment on the same element.
     */
    function markerForElement(element, selector) {
      for (const marker of state.markers.values()) {
        if (marker.element && marker.element.isConnected) {
          if (marker.element === element) return marker;
          continue;
        }
        if (resolveElement(marker) === element) return marker;
      }
      if (!selector) return null;
      for (const marker of state.markers.values()) {
        if (marker.selector !== selector) continue;
        try {
          if (document.querySelectorAll(selector).length === 1) return marker;
        } catch (error) {
          return null;
        }
      }
      return null;
    }

    function onClick(event) {
      if (!state.armed) return;
      if (ourNode(event)) return;
      const element = event.target instanceof Element ? event.target : null;
      if (!element) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      state.hovered = element;
      syncCursor();
      const target = describe(element);
      const existing = markerForElement(element, target.selector);
      if (existing) {
        // One element, one comment: a second click on a pinned element opens
        // that comment for editing instead of the page inventing a second pin.
        openCard(existing.id);
        emit({ kind: 'open', id: existing.id });
        return;
      }
      const id = crypto.randomUUID();
      addMarker({ id: id, number: state.markers.size + 1, comment: '' }, element, target.selector);
      openCard(id);
      emit({ kind: 'pick', id: id, target: target });
    }

    function onKeyDown(event) {
      if (event.key !== 'Escape') return;
      // Escape closes the open comment first, exactly as it does in the app's
      // own editor, and only ends the session when no card is up.
      const active = state.activeId ? state.markers.get(state.activeId) : null;
      if (active && active.card && !active.card.hidden) {
        event.preventDefault();
        event.stopPropagation();
        closeCard(active.id);
        emit({ kind: 'close', id: active.id });
        return;
      }
      if (!state.armed) return;
      event.preventDefault();
      event.stopPropagation();
      state.armed = false;
      state.hovered = null;
      state.hoverId = null;
      syncCursor();
      layout();
      emit({ kind: 'closed' });
    }

    function addListener() {
      if (state.listeners) return;
      document.addEventListener('pointermove', onPointerMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKeyDown, true);
      addEventListener('scroll', onViewportChange, true);
      addEventListener('resize', onViewportChange);
      state.listeners = true;
    }

    function removeListener() {
      if (!state.listeners) return;
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      removeEventListener('scroll', onViewportChange, true);
      removeEventListener('resize', onViewportChange);
      state.listeners = false;
    }

    function onViewportChange() {
      layout();
    }

    /**
     * Keep the page listeners installed while there is a reason for them.
     *
     * Picking is one reason. The pins are the other: they outlive a disarmed
     * tab, and the element a pin belongs to has to light up under the pointer
     * with the pin still on the page, so hover is watched while any marker
     * exists rather than only while inspect mode is on.
     */
    function syncListeners() {
      if (state.armed || state.markers.size > 0) addListener();
      else removeListener();
    }

    function startScan() {
      if (state.scanTimer) return;
      state.scanTimer = setInterval(() => {
        if (state.markers.size === 0) {
          clearInterval(state.scanTimer);
          state.scanTimer = 0;
          syncListeners();
          return;
        }
        layout();
      }, 400);
    }

    function renderPin(marker) {
      const hasComment = Boolean(marker.comment);
      marker.pin.setAttribute('data-comment', hasComment ? '1' : '0');
      marker.pin.title = hasComment ? 'Edit comment on ' + marker.label : 'Comment on ' + marker.label;
      marker.pinLabel.textContent = String(marker.number);
      if (marker.removeButton) marker.removeButton.disabled = !String(marker.comment || '').trim();
    }

    function closeIcon() {
      const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      const a = document.createElementNS(SVG_NAMESPACE, 'path');
      a.setAttribute('d', 'M18 6 6 18');
      const b = document.createElementNS(SVG_NAMESPACE, 'path');
      b.setAttribute('d', 'm6 6 12 12');
      svg.appendChild(a);
      svg.appendChild(b);
      return svg;
    }

    function clearDraftTimer() {
      if (!state.draftTimer) return;
      clearTimeout(state.draftTimer);
      state.draftTimer = 0;
    }

    function emitDraft(marker) {
      clearDraftTimer();
      const comment = String(marker.comment || '');
      emit({ kind: 'draft', id: marker.id, comment: comment });
    }

    function scheduleDraft(marker) {
      clearDraftTimer();
      // The text is reported as it is typed, so the composer chip follows the
      // page, but coalesced: one message per typing burst rather than one per
      // keystroke across the process boundary.
      state.draftTimer = setTimeout(() => {
        state.draftTimer = 0;
        emitDraft(marker);
      }, 220);
    }

    function beginDrag(event, marker) {
      if (event.button !== 0) return;
      const card = marker.card;
      if (!card) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = card.getBoundingClientRect();
      state.drag = { id: marker.id, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      document.addEventListener('pointermove', onDragMove, true);
      document.addEventListener('pointerup', endDrag, true);
      document.addEventListener('pointercancel', endDrag, true);
    }

    function onDragMove(event) {
      const drag = state.drag;
      if (!drag) return;
      const marker = state.markers.get(drag.id);
      if (!marker || !marker.card) return;
      const left = clamp(event.clientX - drag.dx, 4, Math.max(4, innerWidth - marker.card.offsetWidth - 4));
      const top = clamp(event.clientY - drag.dy, 4, Math.max(4, innerHeight - marker.card.offsetHeight - 4));
      marker.cardPos = { left: left, top: top };
      marker.card.style.left = left + 'px';
      marker.card.style.top = top + 'px';
    }

    function endDrag() {
      if (!state.drag) return;
      state.drag = null;
      document.removeEventListener('pointermove', onDragMove, true);
      document.removeEventListener('pointerup', endDrag, true);
      document.removeEventListener('pointercancel', endDrag, true);
    }

    /**
     * The comment card for one marker, built once and reused.
     *
     * The card is drawn by the page, not the app, because a browser page is a
     * native view the app cannot float DOM above; it is the same card the app
     * draws everywhere else, down to the numbered badge, the Close/Remove/Done
     * row and the keyboard shortcuts, built from the app's own theme tokens.
     */
    function ensureCard(marker) {
      if (marker.card) return marker.card;
      const card = document.createElement('div');
      card.className = 'cio-card';
      card.hidden = true;
      // Nothing typed or pressed inside the card is a page pick.
      card.addEventListener('pointerdown', (event) => event.stopPropagation(), true);
      card.addEventListener('click', (event) => event.stopPropagation());

      const head = document.createElement('div');
      head.className = 'cio-card-head';
      const dot = document.createElement('span');
      dot.className = 'cio-card-dot';
      dot.textContent = String(marker.number);
      const name = document.createElement('span');
      name.className = 'cio-card-name';
      name.textContent = marker.label;
      name.title = marker.label;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'cio-card-close';
      close.setAttribute('aria-label', 'Close comment');
      close.title = 'Close comment';
      close.appendChild(closeIcon());
      close.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeCard(marker.id);
        emit({ kind: 'close', id: marker.id });
      });
      head.appendChild(dot);
      head.appendChild(name);
      head.appendChild(close);
      head.addEventListener('pointerdown', (event) => beginDrag(event, marker));

      const body = document.createElement('div');
      body.className = 'cio-card-body';
      const field = document.createElement('textarea');
      field.rows = 3;
      field.placeholder = 'Describe the change for the agent…';
      field.value = String(marker.comment || '');
      field.addEventListener('input', () => {
        marker.comment = field.value;
        renderPin(marker);
        scheduleDraft(marker);
      });
      field.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          commitCard(marker);
        }
      });
      const foot = document.createElement('div');
      foot.className = 'cio-card-foot';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cio-card-btn cio-card-remove';
      remove.textContent = 'Remove';
      remove.title = 'Remove this element comment from the chat';
      remove.disabled = !String(marker.comment || '').trim();
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearDraftTimer();
        emit({ kind: 'remove', id: marker.id });
        closeCard(marker.id);
      });
      const done = document.createElement('button');
      done.type = 'button';
      done.className = 'cio-card-btn cio-card-done';
      done.textContent = 'Done';
      done.title = 'Done: attach this comment to the element';
      done.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        commitCard(marker);
      });
      foot.appendChild(remove);
      foot.appendChild(done);
      body.appendChild(field);
      body.appendChild(foot);
      card.appendChild(head);
      card.appendChild(body);
      layer.appendChild(card);
      marker.card = card;
      marker.field = field;
      marker.removeButton = remove;
      return card;
    }

    function openCard(id) {
      const marker = state.markers.get(id);
      if (!marker) return;
      if (state.activeId && state.activeId !== id) {
        const previous = state.markers.get(state.activeId);
        if (previous && previous.card) previous.card.hidden = true;
      }
      state.activeId = id;
      const card = ensureCard(marker);
      card.hidden = false;
      positionCard(marker);
      const field = marker.field;
      if (field) {
        if (field.value !== String(marker.comment || '')) field.value = String(marker.comment || '');
        // The caret goes to the field so the user can type at once, the moment
        // the card is drawn rather than on a second click.
        setTimeout(() => {
          try {
            field.focus({ preventScroll: true });
            const end = field.value.length;
            field.setSelectionRange(end, end);
          } catch (error) {}
        }, 0);
      }
      renderPin(marker);
      layout();
    }

    function closeCard(id) {
      clearDraftTimer();
      const marker = id ? state.markers.get(id) : null;
      if (marker && marker.card) marker.card.hidden = true;
      if (state.activeId === id) state.activeId = null;
      layout();
    }

    function commitCard(marker) {
      clearDraftTimer();
      emit({ kind: 'done', id: marker.id, comment: String(marker.comment || '') });
      closeCard(marker.id);
    }

    function addMarker(input, element, selector) {
      let marker = state.markers.get(input.id);
      if (!marker) {
        if (state.markers.size >= config.maxMarkers) return null;
        const box = document.createElement('div');
        box.className = 'cio-box cio-marked';
        box.style.display = 'none';
        layer.appendChild(box);
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'cio-pin';
        const pinLabel = document.createElement('span');
        pin.appendChild(pinIcon());
        pin.appendChild(pinLabel);
        layer.appendChild(pin);
        marker = {
          id: input.id,
          number: input.number || state.markers.size + 1,
          comment: input.comment || '',
          label: (element && shortName(element)) || 'element',
          element: element || null,
          selector: selector || '',
          box: box,
          pin: pin,
          pinLabel: pinLabel,
          card: null,
          field: null,
          removeButton: null,
          cardPos: null
        };
        pin.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          // The page owns the card, so a pin click opens it here and tells the
          // app which element the reader asked about.
          openCard(marker.id);
          emit({ kind: 'open', id: marker.id });
        });
        state.markers.set(marker.id, marker);
      }
      if (element) {
        marker.element = element;
        marker.label = shortName(element);
      }
      if (input.selector) marker.selector = input.selector;
      if (typeof input.comment === 'string') {
        const changed = marker.comment !== input.comment;
        marker.comment = input.comment;
        // A comment the renderer changed from elsewhere (a resumed draft, a
        // removal undone) is reflected in the open card without fighting the
        // caret while the user is the one typing.
        if (changed && marker.field && document.activeElement !== marker.field) {
          marker.field.value = input.comment;
        }
      }
      if (input.number) marker.number = input.number;
      renderPin(marker);
      layout();
      startScan();
      syncListeners();
      return marker;
    }

    function removeMarker(id) {
      const marker = state.markers.get(id);
      if (!marker) return;
      clearDraftTimer();
      if (state.drag && state.drag.id === id) endDrag();
      if (state.activeId === id) state.activeId = null;
      if (marker.card) marker.card.remove();
      marker.box.remove();
      marker.pin.remove();
      state.markers.delete(id);
      layout();
      syncListeners();
    }

    /** Open one pinned element's comment and optionally scroll it into view. */
    function focusMarker(id, scroll) {
      const marker = id ? state.markers.get(id) : null;
      if (!marker) {
        closeCard(state.activeId);
        return id === null;
      }
      if (scroll) {
        const element = resolveElement(marker);
        if (element && element.scrollIntoView) {
          element.scrollIntoView({ block: 'center', inline: 'nearest' });
        }
      }
      openCard(marker.id);
      return true;
    }

    function apply(command) {
      if (!command || typeof command !== 'object') return false;
      if (command.type === 'arm') {
        if (!state.armed) {
          state.armed = true;
          syncListeners();
        }
        return true;
      }
      if (command.type === 'disarm') {
        state.armed = false;
        state.hovered = null;
        state.hoverId = null;
        syncCursor();
        if (state.activeId) closeCard(state.activeId);
        syncListeners();
        hoverBox.style.display = 'none';
        labelEl.style.display = 'none';
        return true;
      }
      if (command.type === 'theme') {
        applyTheme(command.theme);
        return true;
      }
      if (command.type === 'focus') {
        return focusMarker(typeof command.id === 'string' ? command.id : null, command.scroll === true);
      }
      if (command.type === 'markers') {
        const incoming = Array.isArray(command.markers) ? command.markers : [];
        const keep = new Set();
        for (const input of incoming) {
          keep.add(input.id);
          addMarker(input, null, input.selector);
        }
        for (const id of Array.from(state.markers.keys())) {
          if (!keep.has(id)) removeMarker(id);
        }
        if (state.activeId && !keep.has(state.activeId)) state.activeId = null;
        layout();
        if (state.markers.size > 0) startScan();
        syncListeners();
        return true;
      }
      if (command.type === 'cease') {
        state.armed = false;
        state.hovered = null;
        removeListener();
        const waiters = state.waiters.splice(0, state.waiters.length);
        for (const resolve of waiters) resolve({ kind: 'closed' });
        return true;
      }
      return false;
    }

    const inspector = {
      run: apply,
      wait: () =>
        new Promise((resolve) => {
          if (state.queued.length > 0) {
            resolve(state.queued.shift());
            return;
          }
          state.waiters.push(resolve);
        })
    };
    Object.defineProperty(globalThis, config.key, {
      value: inspector,
      configurable: true,
      enumerable: false,
      writable: false
    });
    return true;
  } catch (error) {
    // A page that froze the globals this installs into: main abandons the tab.
    return false;
  }
})()`
}

/** A one-way command evaluation against an installed inspector. */
export function inspectorCommandScript(key: string, command: unknown): string {
  return `(() => { const inspector = globalThis[${JSON.stringify(key)}]; return inspector ? inspector.run(${JSON.stringify(command)}) : false; })()`
}

/** The evaluation that installs the inspector (idempotently). */
function inspectorEnsureScript(key: string): string {
  return inspectorInstallScript(key)
}

/** The evaluation that returns the next inspector event. */
export function inspectorWaitScript(key: string): string {
  return `(() => { const inspector = globalThis[${JSON.stringify(key)}]; return inspector ? inspector.wait() : null; })()`
}

/**
 * Owns one inspector per browser tab: installing the script, driving its
 * commands, and keeping a single event promise outstanding per tab.
 */
export class BrowserInspector {
  private readonly tabs = new Map<string, ObservedTab>()

  constructor(private readonly deps: BrowserInspectorDeps) {}

  /** Whether the renderer currently wants inspect mode on for a tab. */
  isArmed(tabId: string): boolean {
    return this.tabs.get(tabId)?.desiredArmed ?? false
  }

  /**
   * Turn inspect mode on or off for a tab. Arming installs the script, replays
   * the current theme and marker set and starts waiting for events; disarming
   * stops the pick listeners but leaves the pins, which still report a click so
   * a comment can be opened from the page at any time.
   *
   * The theme rides on the arm because the page overlay is injected script: it
   * cannot read the application's stylesheet, so it is handed the resolved
   * tokens here, and this is the one call that can guarantee they are applied
   * before the first box is drawn instead of racing a separate push.
   */
  setArmed(
    tabId: string,
    contents: WebContents,
    armed: boolean,
    theme: BrowserInspectorTheme | null
  ): void {
    const record = this.record(tabId, contents)
    record.contents = contents
    record.desiredArmed = armed
    if (theme) record.theme = theme
    if (armed) {
      this.arm(tabId)
      this.command(tabId, { type: 'arm' })
    } else {
      this.command(tabId, { type: 'disarm' })
    }
  }

  /** Re-theme one tab's overlay, and keep the tokens for the next install. */
  syncTheme(tabId: string, theme: BrowserInspectorTheme): void {
    const record = this.tabs.get(tabId)
    if (!record) return
    record.theme = theme
    this.command(tabId, { type: 'theme', theme })
  }

  /**
   * Put one pinned element in front of the user: highlight it, and optionally
   * scroll it into view. This is how a comment the reader clicks in the composer
   * brings the browser back to the element it was written about.
   */
  focus(tabId: string, contents: WebContents, referenceId: string | null, scroll: boolean): void {
    const record = this.record(tabId, contents)
    record.contents = contents
    record.focus = { id: referenceId, scroll }
    this.arm(tabId)
    void this.publishFocus(record).catch(() => undefined)
  }

  /** Replace the marker set the page draws. The renderer owns the truth. */
  syncMarkers(tabId: string, contents: WebContents, markers: BrowserInspectorMarker[]): void {
    const record = this.record(tabId, contents)
    record.contents = contents
    record.markers = markers
    this.arm(tabId)
    this.command(tabId, { type: 'markers', markers })
  }

  /**
   * A new document commits: every event promise from the previous document is
   * void. The desired mode is kept and the wait is re-armed, so a live preview
   * that reloads itself on every edit stays inspectable instead of dropping out
   * of inspection on the first write; the re-arm installs into the new document
   * and replays the mode, the theme, the markers and the highlight.
   */
  reset(tabId: string): void {
    const record = this.tabs.get(tabId)
    if (!record) return
    record.generation += 1
    record.pending = false
    if (this.shouldWatch(record)) this.arm(tabId)
  }

  forget(tabId: string): void {
    const record = this.tabs.get(tabId)
    if (!record) return
    void record.contents
      .executeJavaScript(inspectorCommandScript(record.key, { type: 'cease' }), false)
      .catch(() => undefined)
    this.tabs.delete(tabId)
  }

  dispose(): void {
    for (const tabId of [...this.tabs.keys()]) this.forget(tabId)
  }

  private record(tabId: string, contents: WebContents): ObservedTab {
    let record = this.tabs.get(tabId)
    if (!record) {
      record = {
        contents,
        key: crypto.randomUUID(),
        desiredArmed: false,
        pending: false,
        generation: 0,
        failures: 0,
        markers: [],
        theme: null,
        focus: null
      }
      this.tabs.set(tabId, record)
    }
    return record
  }

  /**
   * Whether this tab still has a reason to wait for events.
   *
   * Armed is the obvious one. The pins are the other: they outlive a disarmed
   * tab on purpose, and a pin the user clicks has to reach the app, so the wait
   * stays outstanding while any pin is on the page.
   */
  private shouldWatch(record: ObservedTab): boolean {
    return record.desiredArmed || record.markers.length > 0
  }

  /** Consume a focus request only after its marker exists in the installed page. */
  private async publishFocus(record: ObservedTab): Promise<void> {
    const focus = record.focus
    if (!focus || record.contents.isDestroyed()) return
    const applied: unknown = await record.contents.executeJavaScript(
      inspectorCommandScript(record.key, { type: 'focus', id: focus.id, scroll: focus.scroll }),
      false
    )
    if (applied === true && record.focus === focus) record.focus = null
  }

  /** Fire a command without waiting, keeping failures off the event loop. */
  private command(tabId: string, command: unknown): void {
    const record = this.tabs.get(tabId)
    if (!record || record.contents.isDestroyed()) return
    void record.contents
      .executeJavaScript(inspectorCommandScript(record.key, command), false)
      .catch(() => undefined)
  }

  /**
   * Install into the current document, re-apply everything the renderer has
   * published, then wait for one event. Every answer re-arms, so an idle tab
   * costs one pending promise and nothing polls.
   *
   * The replay order matters and is not incidental: the mode first, so picking
   * works the moment the document is live; then the theme, so no box is ever
   * drawn in the wrong colours; then the pins, so the focus that follows has
   * something to point at.
   */
  private arm(tabId: string): void {
    const record = this.tabs.get(tabId)
    if (!record || !this.shouldWatch(record) || record.pending || record.contents.isDestroyed()) {
      return
    }
    record.pending = true
    const generation = record.generation
    const issue = (command: unknown): Promise<unknown> =>
      record.contents.executeJavaScript(inspectorCommandScript(record.key, command), false)
    record.contents
      .executeJavaScript(inspectorEnsureScript(record.key), false)
      .then((installed: unknown) => {
        if (installed !== true) throw new Error('inspector refused to install')
        // A document swap starts the installed script unarmed, so the desired
        // mode is asserted here rather than assumed to have survived the load.
        return record.desiredArmed ? issue({ type: 'arm' }) : undefined
      })
      .then(() => (record.theme ? issue({ type: 'theme', theme: record.theme }) : undefined))
      .then(() => issue({ type: 'markers', markers: record.markers }))
      .then(() => this.publishFocus(record))
      .then(() => record.contents.executeJavaScript(inspectorWaitScript(record.key), false))
      .then((event: unknown) => {
        const current = this.tabs.get(tabId)
        if (!current || current !== record) return
        // The document this promise belonged to has ended, so its answer is not
        // an event for the page the user is looking at now.
        if (current.generation !== generation) return
        current.pending = false
        current.failures = 0
        if (event && typeof event === 'object') {
          this.deps.onEvent(tabId, event as BrowserInspectorEvent)
        }
        this.scheduleArm(tabId)
      })
      .catch((error: unknown) => {
        const current = this.tabs.get(tabId)
        if (!current || current !== record) return
        if (current.generation !== generation) return
        current.pending = false
        if (current.contents.isDestroyed()) return
        // A document swap rejects the outstanding promise routinely, so a
        // failure is retried rather than treated as abandon; only a page that
        // keeps refusing is dropped.
        current.failures += 1
        if (current.failures >= MAX_INSPECTOR_ARM_FAILURES) {
          Logger.dev('Design inspector abandoned a tab:', { tabId, error })
          current.desiredArmed = false
          // Tell the renderer, so a toggle that can no longer do anything does
          // not stay on waiting for picks that will never come.
          this.deps.onEvent(tabId, { kind: 'closed' })
          return
        }
        this.scheduleArm(tabId)
      })
  }

  private scheduleArm(tabId: string): void {
    setTimeout(() => this.arm(tabId), INSPECTOR_REARM_INTERVAL_MS)
  }
}
