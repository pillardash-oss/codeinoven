/**
 * Reading a page: the snapshot an agent starts from, and the query it uses when it
 * needs one element's whole truth.
 *
 * Both are built on the deep toolkit, so both see what the page actually renders:
 * elements inside open shadow roots, SVG, and clickable nodes that carry no role.
 * They differ in direction. A snapshot is broad, bounded and cheap, built to answer
 * "what can I act on here". A query is narrow and unlimited in detail, built to
 * answer "what is everything about this one element".
 */

import {
  MAX_LABEL_CHARS,
  MAX_TEXT_CHARS,
  MAX_VALUE_CHARS,
  SNAPSHOT_ROLE_SELECTOR,
  pageRuntimeSource
} from './page-toolkit'

/** The snapshot request a caller may narrow. */
export interface AgentSnapshotOptions {
  /** Read only elements a person could act on, skipping every bare label. */
  interactiveOnly: boolean
  /** Elements the snapshot reports before it is truncated. */
  maxElements: number
  /** Characters of visible page text the snapshot reports, 0 for none. */
  maxText: number
  /** Namespace every reference this document hands out, so a ref names its frame. */
  refPrefix?: string
  /** Also read elements that are only clickable because they draw a pointer. */
  pointerTargets?: boolean
}

/**
 * The candidate selector a snapshot reads.
 *
 * The narrower set drops the things a person reads rather than operates: a label, a
 * picture, a canvas and a media player are content, and an agent that asked for
 * controls does not want them.
 */
function snapshotSelector(interactiveOnly: boolean): string {
  if (!interactiveOnly) return snapshotFullSelector()
  return [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[onclick]',
    '[tabindex]',
    '[draggable="true"]',
    'svg[role]',
    SNAPSHOT_ROLE_SELECTOR
  ].join(', ')
}

/** Every element a person could read, operate, or drop something onto. */
function snapshotFullSelector(): string {
  return [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    'label',
    'canvas',
    'img[alt]',
    'video[controls]',
    'audio[controls]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[onclick]',
    '[tabindex]',
    '[draggable="true"]',
    'svg[role]',
    SNAPSHOT_ROLE_SELECTOR
  ].join(', ')
}

/**
 * Read the page as an agent needs it: the text, plus every element it could act
 * on, each with a reference, a real selector, its live value, its accessibility
 * state and its box.
 *
 * The selector a report carries is a *deep* one (`host >>> inner`) when the element
 * lives inside a shadow root, because that is the only spelling that addresses it,
 * and the reference works whether or not any selector does.
 */
export function agentSnapshotScript(options: AgentSnapshotOptions): string {
  const maxElements = Math.max(1, options.maxElements)
  const maxText = options.maxText > 0 ? Math.min(options.maxText, MAX_TEXT_CHARS) : 0
  return `(() => {
    ${pageRuntimeSource({ refPrefix: options.refPrefix, pointerCandidates: options.pointerTargets })}
    const selector = ${JSON.stringify(snapshotSelector(options.interactiveOnly))};
    const layers = layerList();
    const seen = new Set();
    const candidates = [];
    const consider = (element) => {
      if (!isElement(element) || seen.has(element) || OWNED(element)) return;
      const tag = element.tagName ? element.tagName.toLowerCase() : '';
      if (tag === 'input' && String(element.type).toLowerCase() === 'hidden') return;
      seen.add(element);
      candidates.push(element);
    };
    for (const match of deepQueryAll(selector)) consider(match);
    if (${options.pointerTargets === true ? 'true' : 'false'}) {
      for (const match of pointerCandidates(${Math.max(1, maxElements) * 4})) consider(match);
    }
    const elements = candidates.slice(0, ${maxElements}).map((element) => describe(element, layers));
    const scroller = document.scrollingElement || document.documentElement;
    const roots = deepRoots();
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      text: ${maxText > 0 ? `(document.body ? document.body.innerText || '' : '').slice(0, ${maxText})` : `''`},
      scroll: {
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY),
        height: scroller ? scroller.scrollHeight : 0,
        width: scroller ? scroller.scrollWidth : 0,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      },
      ...(roots.length > 1 ? { shadowRoots: roots.length - 1 } : {}),
      ...(layers.length > 0
        ? {
            layers: layers.slice(0, 16).map((layer) => ({
              role: layer.role,
              selector: deepSelector(layer.node),
              label: labelOf(layer.node)
            }))
          }
        : {}),
      count: candidates.length,
      truncated: candidates.length > elements.length,
      elements
    };
  })()`
}

/** How one element is queried. */
export interface AgentQueryOptions {
  /** A CSS selector, or the deep selector a snapshot reported. */
  selector?: string
  /** A reference a snapshot reported. */
  ref?: string
  /** Elements whose own text contains this, case-insensitively. */
  text?: string
  /** Elements with this role. */
  role?: string
  /** Elements with this tag name. */
  tag?: string
  /** Also walk the document for clickable elements that carry no role. */
  pointerTargets?: boolean
  /** Elements reported before the answer is truncated. */
  limit?: number
  /** Characters of each element's text. */
  maxText?: number
  /** Report every attribute the element carries. */
  attributes?: boolean
  /** Read these properties, dotted paths allowed. */
  properties?: string[]
  /** Read these computed style values. */
  style?: string[]
  /** Read the accessibility description of each element. */
  accessibility?: boolean
  /** Report every property name the element exposes, and the primitive ones. */
  allProperties?: boolean
  /** Characters of the element's own markup, 0 for none. */
  outerHtml?: number
  /** Read inside this element only. */
  scope?: string
}

/**
 * Read one element, or a set of them, in full.
 *
 * This is the operation an agent reaches for when a snapshot's summary is not
 * enough: an arbitrary attribute, a computed style, a property the page keeps its
 * state in, or the accessibility description a screen reader would get. Nothing is
 * guessed and nothing is capped by a summary, which is what makes a strange page
 * workable instead of mysterious.
 */
export function agentQueryScript(options: AgentQueryOptions): string {
  return `(() => {
    ${pageRuntimeSource({ pointerCandidates: options.pointerTargets })}
    const limit = ${Math.max(1, Math.min(options.limit ?? 20, 500))};
    const maxText = ${Math.max(0, Math.min(options.maxText ?? 500, MAX_TEXT_CHARS))};
    const wantedProperties = ${JSON.stringify(options.properties ?? [])};
    const wantedStyle = ${JSON.stringify(options.style ?? [])};
    const scope = ${options.scope ? `resolveElement(${JSON.stringify(options.scope)})` : 'null'};
    if (${options.scope ? 'true' : 'false'} && !scope) {
      return { found: false, reason: 'the element to search inside was not found', count: 0, elements: [] };
    }
    const matches = [];
    const push = (element) => {
      if (!isElement(element) || OWNED(element) || matches.indexOf(element) >= 0) return;
      matches.push(element);
    };
    const byRef = ${options.ref ? JSON.stringify(options.ref) : 'null'};
    const bySelector = ${options.selector ? JSON.stringify(options.selector) : 'null'};
    const byText = ${options.text ? JSON.stringify(options.text.toLowerCase()) : 'null'};
    const byRole = ${options.role ? JSON.stringify(options.role.toLowerCase()) : 'null'};
    const byTag = ${options.tag ? JSON.stringify(options.tag.toLowerCase()) : 'null'};
    if (byRef) {
      const found = resolveRef(byRef);
      if (found) push(found);
    } else if (bySelector) {
      for (const found of deepQueryAll(bySelector, scope || null)) push(found);
    } else if (byRole) {
      for (const found of deepQueryAll('[role]', scope || null)) {
        if ((found.getAttribute('role') || '').toLowerCase() === byRole) push(found);
      }
    } else if (byTag) {
      for (const found of deepQueryAll(byTag, scope || null)) push(found);
    } else if (byText) {
      for (const found of deepQueryAll('*', scope || null)) {
        if (matches.length >= limit) break;
        if (textOf(found, 4000).toLowerCase().indexOf(byText) >= 0) push(found);
      }
    } else if (${options.pointerTargets === true ? 'true' : 'false'}) {
      for (const found of pointerCandidates(limit)) push(found);
    }
    const summarise = (value) => {
      if (value === undefined) return null;
      if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
        return typeof value === 'string' ? value.slice(0, ${MAX_VALUE_CHARS}) : value;
      }
      if (typeof value === 'function') return '[function]';
      if (isElement(value)) return { element: deepSelector(value) };
      try {
        const encoded = JSON.stringify(value);
        return encoded === undefined ? String(value) : encoded.slice(0, ${MAX_VALUE_CHARS});
      } catch { return String(value).slice(0, ${MAX_VALUE_CHARS}); }
    };
    const readPath = (element, path) => {
      let current = element;
      for (const step of path.split('.')) {
        if (current === null || current === undefined) return undefined;
        try { current = current[step]; } catch { return undefined; }
      }
      return current;
    };
    const propertyNames = (element) => {
      const names = new Set();
      let current = element;
      let depth = 0;
      while (current && current !== Object.prototype && depth < 6) {
        for (const name of Object.getOwnPropertyNames(current)) names.add(name);
        current = Object.getPrototypeOf(current);
        depth += 1;
      }
      return Array.from(names).sort().slice(0, 300);
    };
    const layers = layerList();
    const elements = [];
    for (const element of matches.slice(0, limit)) {
      const record = {
        ref: referenceFor(element),
        selector: deepSelector(element),
        tag: element.tagName ? element.tagName.toLowerCase() : '',
        id: element.id || '',
        classes: typeof element.className === 'string' ? element.className : (element.getAttribute('class') || ''),
        visible: isVisible(element),
        box: boxOf(element),
        text: maxText > 0 ? textOf(element, maxText) : ''
      };
      const layer = layerOf(element, layers);
      if (layer) record.layer = layer;
      if (${options.attributes !== false ? 'true' : 'false'}) {
        const attributes = {};
        for (const attribute of Array.from(element.attributes)) {
          attributes[attribute.name] = String(attribute.value).slice(0, ${MAX_VALUE_CHARS});
        }
        record.attributes = attributes;
      }
      if (wantedProperties.length > 0) {
        const properties = {};
        for (const path of wantedProperties) properties[path] = summarise(readPath(element, path));
        record.properties = properties;
      }
      if (${options.allProperties ? 'true' : 'false'}) {
        record.propertyNames = propertyNames(element);
        const primitives = {};
        for (const name of record.propertyNames) {
          let value;
          try { value = element[name]; } catch { continue; }
          if (value === null || typeof value === 'number' || typeof value === 'boolean') primitives[name] = value;
          else if (typeof value === 'string') primitives[name] = value.slice(0, ${MAX_LABEL_CHARS});
        }
        record.properties = Object.assign({}, record.properties || {}, primitives);
      }
      if (wantedStyle.length > 0) {
        let computed = null;
        try { computed = getComputedStyle(element); } catch { computed = null; }
        const style = {};
        for (const name of wantedStyle) style[name] = computed ? computed.getPropertyValue(name) : '';
        record.style = style;
      }
      if (${options.accessibility !== false ? 'true' : 'false'}) {
        const describedBy = (element.getAttribute('aria-describedby') || '')
          .split(/\\s+/)
          .filter(Boolean)
          .map((id) => deepById(id))
          .filter(Boolean)
          .map((node) => textOf(node, ${MAX_LABEL_CHARS}))
          .join(' ');
        const states = {};
        for (const attribute of Array.from(element.attributes)) {
          if (attribute.name.indexOf('aria-') === 0) states[attribute.name.slice(5)] = attribute.value;
        }
        record.accessibility = {
          role: roleOf(element),
          name: accessibleNameOf(element),
          description: (element.getAttribute('aria-description') || describedBy || element.getAttribute('title') || '').slice(0, ${MAX_LABEL_CHARS}),
          states,
          focusable: element.tabIndex >= 0,
          hidden: element.getAttribute('aria-hidden') === 'true'
        };
      }
      if (${(options.outerHtml ?? 0) > 0 ? 'true' : 'false'}) {
        record.html = String(element.outerHTML || '').slice(0, ${Math.max(0, options.outerHtml ?? 0)});
      }
      elements.push(record);
    }
    return { found: elements.length > 0, count: matches.length, elements };
  })()`
}
