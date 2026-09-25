/**
 * Element inspector for the embedded browser.
 *
 * A browser page is a native `WebContentsView` composited ABOVE every DOM
 * surface of the renderer, so nothing the app draws can sit on the page. The
 * Chrome-style inspect affordance therefore lives in the page: this observer
 * injects an idempotent script into the document under a random per-tab global
 * name, exactly the way `browser-capture.ts` does, and that script draws the
 * hover box, the label, the selected border, the numbered pins and the comment
 * box, and reports picks and comments back.
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
 * marker set or an opened comment box costs one evaluation and never blocks the
 * pending event.
 */

import type { WebContents } from 'electron'
import type { BrowserInspectorEvent, BrowserInspectorMarker } from '../../../lib/ipc/browser'
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
      '.cio-hover{background:rgba(79,156,255,.14);outline:1px solid #4f9cff}',
      '.cio-active{background:rgba(79,156,255,.10);outline:2px solid #4f9cff}',
      '.cio-label{position:fixed;pointer-events:none;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 6px;border-radius:5px;background:#111827;color:#f9fafb;font:500 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 2px 8px rgba(0,0,0,.45)}',
      '.cio-label .d{color:#9ca3af}',
      '.cio-pin{position:fixed;pointer-events:auto;cursor:pointer;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 9px;border-radius:999px;border:1px solid #111827;background:#ffffff;color:#111827;font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.35)}',
      '.cio-pin[data-comment="1"]{border-color:#4f9cff;background:#eff6ff}',
      '.cio-editor{position:fixed;pointer-events:auto;width:320px;max-width:92vw;background:#ffffff;color:#111827;border:1px solid rgba(17,24,39,.14);border-radius:12px;padding:10px;box-shadow:0 12px 32px rgba(0,0,0,.30);font:400 12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.cio-editor .h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px}',
      '.cio-editor .h b{font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cio-editor textarea{width:100%;height:66px;resize:vertical;border:1px solid rgba(17,24,39,.18);border-radius:8px;padding:6px 8px;background:#f8fafc;color:#111827;font:inherit;outline:none}',
      '.cio-editor .row{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:8px}',
      '.cio-btn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border:1px solid transparent;border-radius:8px;font:600 11px/1 inherit;cursor:pointer}',
      '.cio-btn.done{background:#4f9cff;color:#ffffff}',
      '.cio-btn.ghost{background:transparent;color:#6b7280}',
      '.cio-btn.danger{background:transparent;color:#dc2626}'
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
    const activeBox = document.createElement('div');
    activeBox.className = 'cio-box cio-active';
    activeBox.style.display = 'none';
    const labelEl = document.createElement('div');
    labelEl.className = 'cio-label';
    labelEl.style.display = 'none';
    layer.appendChild(activeBox);
    layer.appendChild(hoverBox);
    layer.appendChild(labelEl);

    const state = {
      armed: false,
      hovered: null,
      activeId: null,
      editorId: null,
      markers: new Map(),
      waiters: [],
      queued: [],
      scanTimer: 0,
      hoverFrame: 0,
      listeners: false
    };

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const text = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
    const escapeId = (value) => (globalThis.CSS && CSS.escape ? CSS.escape(String(value)) : String(value));

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

    function layout() {
      const active = state.activeId ? state.markers.get(state.activeId) : null;
      const activeElement = active ? resolveElement(active) : null;
      if (activeElement) place(activeElement, activeBox);
      else activeBox.style.display = 'none';

      for (const marker of state.markers.values()) {
        const element = resolveElement(marker);
        if (!element) {
          marker.pin.style.display = 'none';
          continue;
        }
        const rect = element.getBoundingClientRect();
        marker.pin.style.display = 'inline-flex';
        marker.pin.style.left = clamp(rect.x, 2, Math.max(2, innerWidth - 52)) + 'px';
        marker.pin.style.top = clamp(rect.y - 26, 2, Math.max(2, innerHeight - 26)) + 'px';
      }
      layoutEditor();
    }

    function layoutEditor() {
      if (!state.editorId) return;
      const marker = state.markers.get(state.editorId);
      if (!marker) return;
      const rect = marker.pin.getBoundingClientRect();
      const width = 320;
      const left = clamp(rect.left, 8, Math.max(8, innerWidth - width - 8));
      const below = rect.bottom + 8;
      const height = marker.editor.offsetHeight || 150;
      const top = below + height > innerHeight - 8 ? Math.max(8, rect.top - height - 8) : below;
      marker.editor.style.left = left + 'px';
      marker.editor.style.top = top + 'px';
    }

    function syncCursor() {
      if (!state.armed || state.editorId) {
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

    function onPointerMove(event) {
      if (!state.armed || state.editorId) return;
      if (ourNode(event)) return;
      const element = event.target instanceof Element ? event.target : null;
      if (element === state.hovered) return;
      state.hovered = element;
      if (state.hoverFrame) return;
      state.hoverFrame = requestAnimationFrame(() => {
        state.hoverFrame = 0;
        syncCursor();
      });
    }

    function onClick(event) {
      if (!state.armed || state.editorId) return;
      if (ourNode(event)) return;
      const element = event.target instanceof Element ? event.target : null;
      if (!element) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      state.hovered = element;
      syncCursor();
      const target = describe(element);
      const id = crypto.randomUUID();
      addMarker({ id: id, number: state.markers.size + 1, comment: '' }, element, target.selector);
      openEditor(id);
      emit({ kind: 'pick', id: id, target: target });
    }

    function onKeyDown(event) {
      if (!state.armed) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (state.editorId) {
        closeEditor();
        return;
      }
      state.armed = false;
      state.hovered = null;
      syncCursor();
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

    function startScan() {
      if (state.scanTimer) return;
      state.scanTimer = setInterval(() => {
        if (state.markers.size === 0) {
          clearInterval(state.scanTimer);
          state.scanTimer = 0;
          return;
        }
        layout();
      }, 400);
    }

    function renderPin(marker) {
      marker.pin.setAttribute('data-comment', marker.comment ? '1' : '0');
      marker.pin.title = marker.comment ? 'Edit comment on ' + marker.label : 'Comment on ' + marker.label;
      marker.pinLabel.textContent = String(marker.number);
    }

    function addMarker(input, element, selector) {
      let marker = state.markers.get(input.id);
      if (!marker) {
        if (state.markers.size >= config.maxMarkers) return null;
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'cio-pin';
        const icon = document.createElement('span');
        icon.textContent = '\uD83D\uDCAC';
        const pinLabel = document.createElement('span');
        pin.appendChild(icon);
        pin.appendChild(pinLabel);
        const editor = document.createElement('div');
        editor.className = 'cio-editor';
        editor.style.display = 'none';
        layer.appendChild(pin);
        layer.appendChild(editor);
        marker = {
          id: input.id,
          number: input.number || state.markers.size + 1,
          comment: input.comment || '',
          label: (element && shortName(element)) || 'element',
          element: element || null,
          selector: selector || '',
          pin: pin,
          pinLabel: pinLabel,
          editor: editor,
          input: null
        };
        pin.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          if (state.editorId === marker.id) closeEditor();
          else openEditor(marker.id);
        });
        state.markers.set(marker.id, marker);
      }
      if (element) {
        marker.element = element;
        marker.label = shortName(element);
      }
      if (input.selector) marker.selector = input.selector;
      if (typeof input.comment === 'string') marker.comment = input.comment;
      if (input.number) marker.number = input.number;
      renderPin(marker);
      layout();
      startScan();
      return marker;
    }

    function buildEditor(marker) {
      const editor = marker.editor;
      editor.textContent = '';
      const head = document.createElement('div');
      head.className = 'h';
      const title = document.createElement('b');
      title.textContent = 'Comment on ' + marker.label;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'cio-btn ghost';
      close.textContent = 'Close';
      head.appendChild(title);
      head.appendChild(close);
      const area = document.createElement('textarea');
      area.placeholder = 'Describe the change for the agent\u2026';
      area.value = marker.comment;
      const row = document.createElement('div');
      row.className = 'row';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cio-btn danger';
      remove.textContent = 'Remove';
      const done = document.createElement('button');
      done.type = 'button';
      done.className = 'cio-btn done';
      done.textContent = 'Done';
      row.appendChild(remove);
      row.appendChild(done);
      editor.appendChild(head);
      editor.appendChild(area);
      editor.appendChild(row);
      marker.input = area;
      area.addEventListener('input', () => {
        marker.comment = area.value;
        renderPin(marker);
      });
      area.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submitEditor(marker.id);
        }
      });
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeEditor();
      });
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        removeMarker(marker.id, true);
      });
      done.addEventListener('click', (event) => {
        event.stopPropagation();
        submitEditor(marker.id);
      });
      return area;
    }

    function openEditor(id) {
      const marker = state.markers.get(id);
      if (!marker) return;
      if (state.editorId && state.editorId !== id) closeEditor();
      const area = buildEditor(marker);
      marker.editor.style.display = 'block';
      state.editorId = id;
      state.activeId = id;
      layout();
      try {
        area.focus();
      } catch (error) {}
    }

    function closeEditor() {
      const marker = state.editorId ? state.markers.get(state.editorId) : null;
      if (marker) {
        marker.editor.style.display = 'none';
        marker.input = null;
      }
      state.editorId = null;
      state.activeId = null;
      activeBox.style.display = 'none';
      layout();
    }

    function submitEditor(id) {
      const marker = state.markers.get(id);
      if (!marker) return;
      const comment = marker.input ? marker.input.value : marker.comment;
      marker.comment = comment;
      renderPin(marker);
      closeEditor();
      emit({ kind: 'comment', id: id, comment: comment });
    }

    function removeMarker(id, notify) {
      const marker = state.markers.get(id);
      if (!marker) return;
      if (state.editorId === id) closeEditor();
      marker.pin.remove();
      marker.editor.remove();
      state.markers.delete(id);
      layout();
      if (notify) emit({ kind: 'remove', id: id });
    }

    function apply(command) {
      if (!command || typeof command !== 'object') return false;
      if (command.type === 'arm') {
        if (!state.armed) {
          state.armed = true;
          addListener();
        }
        return true;
      }
      if (command.type === 'disarm') {
        state.armed = false;
        state.hovered = null;
        removeListener();
        closeEditor();
        hoverBox.style.display = 'none';
        labelEl.style.display = 'none';
        return true;
      }
      if (command.type === 'markers') {
        const incoming = Array.isArray(command.markers) ? command.markers : [];
        const keep = new Set();
        for (const input of incoming) {
          keep.add(input.id);
          addMarker(input, null, input.selector);
        }
        for (const id of Array.from(state.markers.keys())) {
          if (!keep.has(id)) removeMarker(id, false);
        }
        layout();
        if (state.markers.size > 0) startScan();
        return true;
      }
      if (command.type === 'editor') {
        if (command.editor && command.editor.id) {
          const marker = state.markers.get(command.editor.id);
          if (marker && typeof command.editor.comment === 'string') marker.comment = command.editor.comment;
          openEditor(command.editor.id);
        } else {
          closeEditor();
        }
        return true;
      }
      if (command.type === 'cease') {
        state.armed = false;
        state.hovered = null;
        removeListener();
        closeEditor();
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
   * the current marker set and starts waiting for events; disarming stops the
   * pick listeners but leaves the pins, so a comment can still be opened.
   */
  setArmed(tabId: string, contents: WebContents, armed: boolean): void {
    const record = this.record(tabId, contents)
    record.contents = contents
    record.desiredArmed = armed
    if (armed) {
      this.arm(tabId)
      this.command(tabId, { type: 'arm' })
    } else {
      this.command(tabId, { type: 'disarm' })
    }
  }

  /** Replace the marker set the page draws. The renderer owns the truth. */
  syncMarkers(tabId: string, markers: BrowserInspectorMarker[]): void {
    const record = this.tabs.get(tabId)
    if (!record) return
    record.markers = markers
    this.command(tabId, { type: 'markers', markers })
  }

  /**
   * A new document commits: every event promise from the previous document is
   * void. The desired mode is kept and the wait is re-armed, so a live preview
   * that reloads itself on every edit stays inspectable instead of dropping out
   * of inspection on the first write; the re-arm installs into the new document
   * and replays the markers.
   */
  reset(tabId: string): void {
    const record = this.tabs.get(tabId)
    if (!record) return
    record.generation += 1
    record.pending = false
    if (record.desiredArmed) this.arm(tabId)
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
        markers: []
      }
      this.tabs.set(tabId, record)
    }
    return record
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
   * Install into the current document, replay the markers, then wait for one
   * event. Every answer re-arms, so an idle tab costs one pending promise and
   * nothing polls.
   */
  private arm(tabId: string): void {
    const record = this.tabs.get(tabId)
    if (!record || !record.desiredArmed || record.pending || record.contents.isDestroyed()) return
    record.pending = true
    const generation = record.generation
    record.contents
      .executeJavaScript(inspectorEnsureScript(record.key), false)
      .then((installed: unknown) => {
        if (installed !== true) throw new Error('inspector refused to install')
        return record.contents.executeJavaScript(
          inspectorCommandScript(record.key, { type: 'markers', markers: record.markers }),
          false
        )
      })
      .then(() => {
        return record.contents.executeJavaScript(inspectorWaitScript(record.key), false)
      })
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
