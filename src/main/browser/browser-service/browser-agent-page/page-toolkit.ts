/**
 * The DOM layer every agent page script runs on.
 *
 * This is the part of the browser capability that decides what the agent can see
 * and what it can address, and it exists because a page is not a flat document of
 * HTML elements:
 *
 * 1. **Shadow DOM.** The component model behind the modern web (Fluent UI and the
 *    Azure portal, FAST, Polymer, Lit, most design systems) renders its real
 *    controls inside open shadow roots, where `document.querySelector` cannot see
 *    them. A page read with a flat query looks empty, and an element resolved with
 *    one answers "not found". Every lookup here therefore walks the document and
 *    every open shadow root beneath it, and reports a selector path that crosses
 *    those boundaries (`fluent-button >>> a`).
 * 2. **Any element, not just HTML.** `HTMLElement` excludes SVG, and SVG is how
 *    icons, charts, maps and many icon buttons are drawn. Everything here works on
 *    `Element`, so a `<path>` in a chart is as addressable as a `<button>`.
 * 3. **A reference that survives.** A selector cannot always be written (a shadow
 *    root, an anonymous node in a virtualized list), so a reference is remembered
 *    against the node itself as well as written onto it, and resolution tries the
 *    remembered node first. That is what makes a ref reported minutes ago still act
 *    on the element it named.
 * 4. **Hit testing that agrees with the browser.** `document.elementFromPoint`
 *    stops at a shadow host. A hit test that stops there reports the host as an
 *    overlay covering the element the pointer was aimed at, which refuses the
 *    trusted pointer click and falls back to an untrusted DOM one. The hit test
 *    here descends through shadow roots and compares with composed containment, so
 *    a click inside a web component lands as a real click.
 *
 * It is emitted as source rather than imported, because it runs in the page's own
 * world through `executeJavaScript`, and the tests evaluate exactly the text the
 * page receives.
 */

/** The attribute a snapshot reference lives on. Page-side, survives until reload. */
export const AGENT_REF_ATTRIBUTE = 'data-cio-ref'

/**
 * Marks a node the agent's own overlay added, so no snapshot reports it and no
 * action resolves it as page content.
 */
export const AGENT_OWNED_ATTRIBUTE = 'data-cio-agent'

/** The global the toolkit is reachable at, so `evaluate` can use it directly. */
export const AGENT_TOOLKIT_GLOBAL = '__cio'

/** Refs one document may hand out, so a busy single-page app cannot exhaust memory. */
export const MAX_REFS = 5000
/** Characters of one element's label a report carries. */
export const MAX_LABEL_CHARS = 200
/** Characters of one element's value a report carries. */
export const MAX_VALUE_CHARS = 400
/** Options a `<select>` reports before it is summarised instead. */
export const MAX_OPTIONS = 40
/** Characters of page text a report carries before it is truncated. */
export const MAX_TEXT_CHARS = 40000
/** Open shadow roots one query descends into, so a pathological page stays bounded. */
export const MAX_SHADOW_ROOTS = 512
/** Ancestors one composed containment walk follows before it gives up. */
const MAX_COMPOSED_DEPTH = 200
/** Floating layers one read reports, so a page of tooltips stays cheap. */
export const MAX_LAYERS = 64

/**
 * Interactive roles a page may use, whatever its markup looks like.
 *
 * This list is page content, not this app's own UI language: it is what other
 * people's forms, menus, charts and toggles actually use, and an agent that cannot
 * see a role-checkbox switch cannot operate the page it was sent to.
 */
export const SNAPSHOT_ROLE_SELECTOR = [
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="treeitem"]',
  '[role="gridcell"]',
  '[role="row"]',
  '[role="img"]'
].join(', ')

/**
 * Elements a snapshot considers, before any pointer-shaped candidate is added.
 *
 * `[onclick]` and `[tabindex]` are here because a page's own clickable `div` and a
 * custom element that takes focus carry no role and no interactive tag at all, and
 * they are exactly what a card, a chart point or an icon button is drawn with.
 */
export const SNAPSHOT_SELECTOR = [
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

/** Roles that mean "this element is a floating layer drawn over the page". */
const LAYER_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="listbox"]',
  '[role="tree"]',
  '[role="grid"]',
  '[role="tooltip"]',
  '[aria-modal="true"]',
  'dialog[open]',
  '[popover]'
].join(', ')

/** How one script is generated. */
export interface PageToolkitOptions {
  /**
   * Namespace every reference this document hands out, so a reference reports the
   * frame it belongs to as well as the element (`f2r7`).
   */
  refPrefix?: string
  /**
   * Publish the toolkit on the page's global as `__cio`, so an `evaluate`
   * expression can drive the same deep DOM helpers an operation uses.
   */
  install?: boolean
  /**
   * Also consider elements a person can only reach because they draw a pointer
   * (`cursor: pointer`), which is how a div, a chart point or an SVG group becomes
   * clickable with no role and no tag to say so.
   */
  pointerCandidates?: boolean
}

/**
 * The toolkit, as the page receives it.
 *
 * Emitted once per script rather than stored on the page: a snapshot must describe
 * the live document, and a cache between calls would describe a document that has
 * since been replaced by a navigation or a framework re-render.
 */
export function pageToolkitSource(options: PageToolkitOptions = {}): string {
  const refPrefix = options.refPrefix ?? ''
  return `
  const REF_ATTR = ${JSON.stringify(AGENT_REF_ATTRIBUTE)};
  const MARK_ATTR = ${JSON.stringify(AGENT_OWNED_ATTRIBUTE)};
  const REF_PREFIX = ${JSON.stringify(refPrefix)};
  const MAX_REFS = ${MAX_REFS};
  const MAX_SHADOW_ROOTS = ${MAX_SHADOW_ROOTS};
  const MAX_LAYERS = ${MAX_LAYERS};
  const OWNED = (node) => node instanceof Element ? node.closest('[' + MARK_ATTR + ']') : null;
  const isElement = (node) => typeof Element !== 'undefined' && node instanceof Element;
  const rootOf = (node) => {
    if (!node) return null;
    if (typeof node.getRootNode === 'function') {
      try { return node.getRootNode() || null; } catch { return null; }
    }
    return null;
  };
  const parentAcross = (node) => {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = rootOf(node);
    if (root && root.host) return root.host;
    return null;
  };
  const cssEscape = (value) => {
    if (globalThis.CSS && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => '\\\\' + character);
  };

  /* ---------------------------------------------------------------- refs --- */

  const refStore = () => {
    let store = globalThis.__cioAgentRefStore;
    if (!(store instanceof Map)) {
      store = new Map();
      try {
        Object.defineProperty(globalThis, '__cioAgentRefStore', {
          value: store, configurable: true, writable: true, enumerable: false
        });
      } catch { globalThis.__cioAgentRefStore = store; }
      if (typeof globalThis.__cioAgentRefSeq !== 'number') globalThis.__cioAgentRefSeq = 0;
    }
    return store;
  };
  const holdRef = (ref, element) => {
    const store = refStore();
    if (store.size > MAX_REFS) store.clear();
    try {
      store.set(ref, typeof WeakRef === 'function' ? new WeakRef(element) : element);
    } catch { store.set(ref, element); }
  };
  const heldRef = (ref) => {
    const held = refStore().get(ref);
    if (!held) return null;
    let element = null;
    try {
      element = typeof WeakRef === 'function' && held instanceof WeakRef ? held.deref() : held;
    } catch { element = null; }
    return isElement(element) && element.isConnected ? element : null;
  };

  /**
   * What a reference was handed out for, remembered beside the node itself.
   *
   * A page that renders from state replaces its nodes: the framework throws the old
   * input away and mounts a new one, so an attribute written onto the old node is
   * gone and a reference that only lived in that attribute dies with it. Acting on a
   * page that redraws itself, which the Azure portal is, therefore used to fail every
   * action with "target changed": the reference no longer resolved, and the node it
   * named was not the node the page was showing any more.
   *
   * The anchor is the identity of the control rather than the node: its tag, its id,
   * name, aria-label and placeholder, the role it presents and the short text it
   * carried. A reference that no longer resolves is looked up again through it, and
   * only accepted when the match is unique, so a redraw heals the reference instead
   * of failing the action. This is the same rule a person follows: the search box is
   * still the search box after the page re-renders it.
   */
  const anchorStore = () => {
    let store = globalThis.__cioAgentRefAnchors;
    if (!(store instanceof Map)) {
      store = new Map();
      try {
        Object.defineProperty(globalThis, '__cioAgentRefAnchors', {
          value: store, configurable: true, writable: true, enumerable: false
        });
      } catch { globalThis.__cioAgentRefAnchors = store; }
    }
    return store;
  };

  const rememberAnchor = (ref, element) => {
    if (!isElement(element)) return;
    const store = anchorStore();
    if (store.size > MAX_REFS) store.clear();
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    store.set(ref, {
      tag,
      id: element.id || '',
      name: element.getAttribute('name') || '',
      ariaLabel: element.getAttribute('aria-label') || '',
      placeholder: element.getAttribute('placeholder') || '',
      role: (element.getAttribute('role') || '').toLowerCase(),
      text: tag === 'input' || tag === 'textarea' ? '' : textOf(element, 120),
      selector: localSelector(element)
    });
  };

  /**
   * The element an anchor still describes, or null when it is gone or ambiguous.
   *
   * Every candidate is accepted only when it matches exactly one element, because a
   * healed reference must never point at a neighbour: acting on the wrong control is
   * worse than reporting that the control is gone.
   */
  const findByAnchor = (anchor) => {
    if (!anchor) return null;
    const tag = anchor.tag || '';
    const unique = (selector) => {
      if (!selector) return null;
      const matches = deepQueryAll(selector);
      return matches.length === 1 ? matches[0] : null;
    };
    const quoted = (value) => JSON.stringify(value);
    // Position is the last resort and only for a control that had no identity of its
    // own: healing a named control by where it sat would act on a neighbour the moment
    // the page reorders, which is exactly the mistake this must not make.
    const hasIdentity = Boolean(anchor.id || anchor.name || anchor.ariaLabel || anchor.placeholder);
    const candidates = [
      anchor.id ? '#' + cssEscape(anchor.id) : '',
      tag && anchor.name ? tag + '[name=' + quoted(anchor.name) + ']' : '',
      tag && anchor.ariaLabel ? tag + '[aria-label=' + quoted(anchor.ariaLabel) + ']' : '',
      tag && anchor.placeholder ? tag + '[placeholder=' + quoted(anchor.placeholder) + ']' : '',
      hasIdentity ? '' : anchor.selector || ''
    ];
    for (const selector of candidates) {
      const found = unique(selector);
      if (found) return found;
    }
    if (tag && anchor.text) {
      const matches = deepQueryAll(tag).filter((node) => {
        if (anchor.role && (node.getAttribute('role') || '').toLowerCase() !== anchor.role) return false;
        return textOf(node, 120) === anchor.text;
      });
      if (matches.length === 1) return matches[0];
    }
    return null;
  };

  /* ------------------------------------------------------------ traversal --- */

  /**
   * The document, then every open shadow root beneath it, in tree order.
   *
   * A closed shadow root is unreachable by design and is reported as absent rather
   * than silently skipped: the page itself is the only thing that can open it.
   */
  const deepRoots = () => {
    const roots = [document];
    for (let index = 0; index < roots.length && roots.length < MAX_SHADOW_ROOTS; index += 1) {
      let all;
      try { all = roots[index].querySelectorAll('*'); } catch { continue; }
      for (const node of all) {
        if (node.shadowRoot && roots.length < MAX_SHADOW_ROOTS) roots.push(node.shadowRoot);
      }
    }
    return roots;
  };

  /**
   * Every element in this document, shadow roots included, that matches.
   *
   * The agent's own overlay is never a candidate: a mark the tool drew must never
   * be reported as page content or clicked as if a person had put it there.
   */
  const deepQueryAll = (selector, scope) => {
    const found = [];
    const roots = scope ? [scope] : deepRoots();
    for (const root of roots) {
      let matches;
      try { matches = root.querySelectorAll(selector); } catch { matches = null; }
      if (!matches) continue;
      for (const match of matches) if (!OWNED(match)) found.push(match);
    }
    return found;
  };

  /** The first element a deep lookup finds, or null. */
  const deepQuery = (selector, scope) => {
    const roots = scope ? [scope] : deepRoots();
    for (const root of roots) {
      let match;
      try { match = root.querySelector(selector); } catch { match = null; }
      if (match && !OWNED(match)) return match;
    }
    return null;
  };

  /** An element by id, in the document or inside any open shadow root. */
  const deepById = (id) => {
    if (!id) return null;
    const direct = document.getElementById(id);
    if (direct) return direct;
    for (const root of deepRoots()) {
      if (root === document || !root.getElementById) continue;
      const found = root.getElementById(id);
      if (found) return found;
    }
    return null;
  };

  /* ------------------------------------------------------------ selectors --- */

  const matchesOneIn = (root, selector) => {
    if (!root) return false;
    try { return root.querySelectorAll(selector).length === 1; } catch { return false; }
  };

  /**
   * The shortest selector that names this element inside its own tree scope.
   *
   * A tree scope is what a shadow boundary changes: a selector written there is
   * resolved against that root, never against the document.
   */
  const localSelector = (element) => {
    const root = rootOf(element);
    if (element.id && matchesOneIn(root, '#' + cssEscape(element.id))) {
      return '#' + cssEscape(element.id);
    }
    for (const attribute of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'placeholder', 'title']) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const selector = element.tagName.toLowerCase() + '[' + attribute + '=' + JSON.stringify(value) + ']';
      if (matchesOneIn(root, selector)) return selector;
    }
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 12) {
      if (node.id && matchesOneIn(rootOf(node), '#' + cssEscape(node.id))) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      parts.unshift(
        siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag
      );
      node = parent;
    }
    return parts.join(' > ');
  };

  /**
   * A selector path from the document to this element, crossing shadow boundaries.
   *
   * A path of the form a >>> b means "b inside the shadow root of a", which is the one way to write a
   * selector for a node a page rendered inside a component.
   */
  const deepSelector = (element) => {
    let path = localSelector(element);
    let current = element;
    for (let depth = 0; depth < 20; depth += 1) {
      const root = rootOf(current);
      if (!root || !root.host) break;
      current = root.host;
      path = localSelector(current) + ' >>> ' + path;
    }
    return path;
  };

  /* ------------------------------------------------------------ resolving --- */

  /**
   * The element a reference names, healing it when the page has redrawn it.
   *
   * The order is the whole point: the node handed out is tried first, then the
   * attribute it carried, then the identity recorded beside it. Only the last step
   * ever guesses, and it refuses to guess when the identity is not unique.
   */
  const resolveRef = (ref) => {
    const held = heldRef(ref);
    if (held) return held;
    const stamped = deepQuery('[' + REF_ATTR + '=' + JSON.stringify(ref) + ']');
    if (stamped) { holdRef(ref, stamped); return stamped; }
    const revived = findByAnchor(anchorStore().get(ref));
    if (!revived) return null;
    holdRef(ref, revived);
    rememberAnchor(ref, revived);
    try { revived.setAttribute(REF_ATTR, ref); } catch { /* a locked node keeps no attribute */ }
    return revived;
  };

  const referenceFor = (element) => {
    const existing = element.getAttribute(REF_ATTR);
    if (existing) {
      holdRef(existing, element);
      rememberAnchor(existing, element);
      return existing;
    }
    const next = (globalThis.__cioAgentRefSeq || 0) + 1;
    globalThis.__cioAgentRefSeq = next;
    const reference = REF_PREFIX + 'r' + next;
    if (next <= MAX_REFS) {
      try { element.setAttribute(REF_ATTR, reference); } catch { /* a locked node keeps no attribute */ }
    }
    holdRef(reference, element);
    rememberAnchor(reference, element);
    return reference;
  };

  /**
   * The element a selector or reference names.
   *
   * A bare reference is answered from the ref store first, which is the only way to
   * reach a node with no writable attribute or no reachable selector at all. A CSS
   * selector is answered inside the document first (so a page's own #id keeps
   * meaning what it meant), then across shadow roots, so an ordinary selector still
   * finds a control a component drew.
   */
  const resolveElement = (selector) => {
    if (typeof selector !== 'string' || selector.length === 0) return null;
    if (/^(?:f\\d{1,3})?r\\d{1,6}$/.test(selector)) return resolveRef(selector);
    const asRef = /^\\[data-cio-ref="([^"]+)"\\]$/.exec(selector);
    if (asRef) {
      const fromRef = resolveRef(asRef[1]);
      if (fromRef) return fromRef;
    }
    if (selector.indexOf(' >>> ') >= 0) {
      const parts = selector.split(' >>> ');
      let scope = document;
      let current = null;
      for (const part of parts) {
        if (!scope) return null;
        let found = null;
        try { found = scope.querySelector(part); } catch { found = null; }
        current = found;
        scope = found && found.shadowRoot ? found.shadowRoot : null;
      }
      return isElement(current) ? current : null;
    }
    let direct = null;
    try { direct = document.querySelector(selector); } catch { direct = null; }
    if (isElement(direct)) return direct;
    return deepQuery(selector);
  };

  /* --------------------------------------------------------- composition --- */

  /** The chain of nodes this one was rendered through, up to the document. */
  const composedChain = (node) => {
    const chain = [];
    let current = node;
    for (let depth = 0; current && depth < ${MAX_COMPOSED_DEPTH}; depth += 1) {
      chain.push(current);
      current = parentAcross(current);
    }
    return chain;
  };

  /** Whether one node is the other, or contains it through every shadow boundary. */
  const containsComposed = (ancestor, node) => {
    if (!ancestor || !node) return false;
    if (ancestor === node) return true;
    if (typeof ancestor.contains === 'function' && ancestor.contains(node)) return true;
    return composedChain(node).indexOf(ancestor) >= 0;
  };

  /* --------------------------------------------------------- hit testing --- */

  /** The deepest element at a point, inside every shadow root the point lands in. */
  const deepElementFromPoint = (x, y) => {
    let found = null;
    try { found = document.elementFromPoint(x, y); } catch { found = null; }
    for (let depth = 0; found && found.shadowRoot && depth < 20; depth += 1) {
      let inner = null;
      try { inner = found.shadowRoot.elementFromPoint(x, y); } catch { inner = null; }
      if (!inner || inner === found) break;
      found = inner;
    }
    return found;
  };

  /** Every element at a point, deepest first, so an overlay can be named. */
  const deepStackFromPoint = (x, y) => {
    const stack = [];
    let view = document;
    let checks = 0;
    while (view && checks < 20) {
      checks += 1;
      let nodes = [];
      try { nodes = Array.from(view.elementsFromPoint(x, y)); } catch { nodes = []; }
      for (const node of nodes) if (stack.indexOf(node) < 0) stack.push(node);
      let next = null;
      for (const node of stack) {
        if (node.shadowRoot && containsComposed(node, stack[0] || node)) { next = node.shadowRoot; break; }
      }
      if (!next || next === view) break;
      view = next;
    }
    return stack;
  };

  /* ------------------------------------------------------------- layout --- */

  const isVisible = (element) => {
    if (!isElement(element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (typeof element.checkVisibility === 'function') {
      try {
        return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      } catch { return true; }
    }
    return element.getClientRects().length > 0;
  };

  const boxOf = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height)
    };
  };

  const cursorOf = (element) => {
    try { return (getComputedStyle(element).cursor || '').toLowerCase(); } catch { return ''; }
  };

  /* ----------------------------------------------------------- text/state --- */

  const textOf = (element, limit) => {
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    const raw = tag === 'input' || tag === 'textarea'
      ? element.value
      : (element.innerText || element.textContent || '');
    return String(raw || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
  };

  const labelOf = (element) => {
    const parts = [];
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      for (const id of labelledBy.split(/\\s+/)) {
        const node = deepById(id);
        if (node) parts.push(node.innerText || node.textContent || '');
      }
    }
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) parts.push(ariaLabel);
    if (element.labels) {
      for (const label of Array.from(element.labels)) parts.push(label.innerText || label.textContent || '');
    }
    const alt = element.getAttribute('alt');
    if (alt) parts.push(alt);
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    if (tag === 'input' && ['submit', 'button', 'reset'].indexOf(element.type) >= 0) {
      parts.push(element.value || '');
    }
    const title = element.getAttribute('title');
    if (title) parts.push(title);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) parts.push(placeholder);
    const text = textOf(element, ${MAX_LABEL_CHARS});
    if (text) parts.push(text);
    return parts
      .join(' ')
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, ${MAX_LABEL_CHARS});
  };

  /** The role the page presents, whether it wrote one or relies on its tag. */
  const roleOf = (element) => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit.trim().toLowerCase();
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : '';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (tag === 'svg') return 'img';
    if (tag === 'input') {
      const type = String(element.type || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      return 'textbox';
    }
    if (element.isContentEditable) return 'textbox';
    return '';
  };

  /**
   * The name a screen reader would announce, following the accessibility rules.
   *
   * These are not the label a search wants: an aria-label replaces the text, it does
   * not add to it, and a title is only used when nothing else named the element. That
   * is the difference between reading a page and hearing it.
   */
  const accessibleNameOf = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = [];
      for (const id of labelledBy.split(/\\s+/)) {
        const node = deepById(id);
        if (node) parts.push(node.innerText || node.textContent || '');
      }
      const joined = parts.join(' ').replace(/\\s+/g, ' ').trim();
      if (joined) return joined.slice(0, ${MAX_LABEL_CHARS});
    }
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().slice(0, ${MAX_LABEL_CHARS});
    if (element.labels && element.labels.length > 0) {
      const joined = Array.from(element.labels)
        .map((label) => label.innerText || label.textContent || '')
        .join(' ')
        .replace(/\\s+/g, ' ')
        .trim();
      if (joined) return joined.slice(0, ${MAX_LABEL_CHARS});
    }
    const alt = element.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim().slice(0, ${MAX_LABEL_CHARS});
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    if (tag === 'input') {
      const type = String(element.type || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        const value = String(element.value || '').trim();
        if (value) return value.slice(0, ${MAX_LABEL_CHARS});
      }
    }
    const content = textOf(element, ${MAX_LABEL_CHARS});
    if (content) return content;
    const title = element.getAttribute('title');
    return title ? title.trim().slice(0, ${MAX_LABEL_CHARS}) : '';
  };

  /**
   * The element's own accessibility states.
   *
   * Only state attributes travel: an id-reference (aria-controls, aria-labelledby)
   * is available through the query operation, and carrying every one of them in a
   * snapshot would cost more than the elements themselves.
   */
  const STATE_ATTRIBUTES = [
    'aria-expanded', 'aria-checked', 'aria-pressed', 'aria-selected', 'aria-disabled',
    'aria-required', 'aria-invalid', 'aria-readonly', 'aria-current', 'aria-level',
    'aria-sort', 'aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-valuetext',
    'aria-haspopup', 'aria-busy', 'aria-live', 'aria-modal', 'aria-multiselectable',
    'aria-orientation', 'aria-autocomplete'
  ];
  const ariaOf = (element) => {
    const states = {};
    let count = 0;
    for (const name of STATE_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value === null) continue;
      states[name.slice(5)] = value;
      count += 1;
      if (count >= 12) break;
    }
    return states;
  };

  const valueOf = (element) => {
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    if (tag === 'input' && element.type === 'password') {
      return { value: '[redacted]', valueLength: (element.value || '').length };
    }
    if (tag === 'input' || tag === 'textarea') {
      return { value: String(element.value || '').slice(0, ${MAX_VALUE_CHARS}) };
    }
    if (element.isContentEditable) return { value: textOf(element, ${MAX_VALUE_CHARS}) };
    return {};
  };

  const optionsOf = (element) => {
    if (!(element instanceof HTMLSelectElement)) return {};
    const all = Array.from(element.options);
    return {
      multiple: element.multiple,
      selected: all.filter((option) => option.selected).map((option) => option.value),
      options: all.slice(0, ${MAX_OPTIONS}).map((option) => ({
        value: option.value,
        label: (option.text || '').trim().slice(0, 120),
        selected: option.selected
      })),
      ...(all.length > ${MAX_OPTIONS} ? { optionsTotal: all.length } : {})
    };
  };

  /* ------------------------------------------------------------ layers --- */

  /** Every floating layer the page is showing right now. */
  const layerList = () => {
    const layers = [];
    for (const node of deepQueryAll(${JSON.stringify(LAYER_SELECTOR)})) {
      if (layers.length >= MAX_LAYERS) break;
      if (!isVisible(node)) continue;
      layers.push({ node, role: node.getAttribute('role') || node.tagName.toLowerCase() });
    }
    return layers;
  };

  /** The name of the floating layer this element sits in, or an empty string. */
  const layerOf = (element, layers) => {
    for (const layer of layers || layerList()) {
      if (layer.node === element) return layer.role;
      if (containsComposed(layer.node, element)) return layer.role;
    }
    return '';
  };

  /* ---------------------------------------------------------- describing --- */

  /** Whether the element is drawn inside a shadow root, however deep. */
  const isInShadow = (element) => {
    let node = element;
    for (let depth = 0; node && depth < 20; depth += 1) {
      const root = rootOf(node);
      if (root && root.host) return true;
      node = node.parentElement;
    }
    return false;
  };

  const describe = (element, layers) => {
    const reference = referenceFor(element);
    const shadowed = isInShadow(element);
    const description = {
      ref: reference,
      selector: deepSelector(element),
      tag: element.tagName ? element.tagName.toLowerCase() : '',
      role: roleOf(element),
      type: element.tagName && element.tagName.toLowerCase() === 'input' ? (element.type || 'text') : '',
      name: element.getAttribute('name') || '',
      label: labelOf(element),
      visible: isVisible(element),
      box: boxOf(element),
      ...valueOf(element),
      ...optionsOf(element)
    };
    const aria = ariaOf(element);
    if (Object.keys(aria).length > 0) description.aria = aria;
    if (shadowed) description.shadow = true;
    const layer = layers ? layerOf(element, layers) : '';
    if (layer) description.layer = layer;
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    if (tag === 'input') {
      if (element.type === 'checkbox' || element.type === 'radio') description.checked = element.checked;
      if (element.disabled) description.disabled = true;
      if (element.readOnly) description.readOnly = true;
      if (element.required) description.required = true;
      if (element.accept) description.accept = element.accept;
    }
    if (tag === 'textarea') {
      if (element.disabled) description.disabled = true;
      if (element.readOnly) description.readOnly = true;
      if (element.required) description.required = true;
    }
    if (element.disabled === true && tag === 'select') description.disabled = true;
    const href = element.getAttribute('href');
    if (href) description.href = href.slice(0, 500);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) description.placeholder = placeholder.slice(0, 200);
    const expanded = element.getAttribute('aria-expanded');
    if (expanded) description.expanded = expanded === 'true';
    if (element.isContentEditable) description.editable = true;
    if (element.hasAttribute('disabled')) description.disabled = true;
    return description;
  };
`
}

/**
 * The toolkit plus a pointer-shaped candidate finder, for the reads that have to
 * see elements no attribute announces.
 */
export function pointerCandidateSource(): string {
  return `
  /**
   * Elements a person can only reach because they draw a pointer.
   *
   * A card, a chart segment, an SVG group and an icon wrapper often carry no role,
   * no tabindex and no handler attribute: they are clickable because their own
   * script listens for a click and their CSS says so. Reading the cursor is the only
   * signal the document itself gives, and it is expensive, so it is only read when a
   * caller asks for it.
   */
  const pointerCandidates = (limit) => {
    const found = [];
    for (const root of deepRoots()) {
      let all;
      try { all = root.querySelectorAll('*'); } catch { continue; }
      for (const node of all) {
        if (found.length >= limit) return found;
        if (OWNED(node) || node.namespaceURI === 'http://www.w3.org/2000/svg') continue;
        if (cursorOf(node) !== 'pointer') continue;
        found.push(node);
      }
    }
    return found;
  };
`
}

/**
 * The toolkit published on the page's global as `__cio`.
 *
 * An `evaluate` expression is the escape hatch for everything the operations do not
 * cover, and it is worth much more when it can reach the same deep DOM layer they
 * use: `__cio.deep('my-field').value` works inside a shadow root, `__cio.ref('r7')`
 * resolves a reference a snapshot reported, and `__cio.layers()` names the floating
 * layers on screen.
 */
export function toolkitInstallSource(): string {
  return `
  const TOOLKIT = {
    deep: (selector, scope) => deepQuery(selector, scope || null),
    all: (selector, scope) => deepQueryAll(selector, scope || null),
    roots: () => deepRoots(),
    ref: (reference) => typeof reference === 'string'
      ? (/^(?:f\\d{1,3})?r\\d{1,6}$/.test(reference) ? resolveRef(reference) : resolveElement(reference))
      : null,
    selector: (element) => isElement(element) ? deepSelector(element) : '',
    describe: (element) => isElement(element) ? describe(element, layerList()) : null,
    visible: (element) => isElement(element) ? isVisible(element) : false,
    point: (element) => isElement(element) ? elementPoint(element) : null,
    hit: (x, y) => deepElementFromPoint(x, y),
    stack: (x, y) => deepStackFromPoint(x, y),
    layers: () => layerList().map((layer) => ({
      role: layer.role, selector: deepSelector(layer.node), text: textOf(layer.node, ${MAX_VALUE_CHARS})
    })),
    byText: (text, scope) => {
      const wanted = String(text || '').trim().toLowerCase();
      if (!wanted) return [];
      return deepQueryAll('*', scope || null).filter((node) => {
        const own = textOf(node, 4000).toLowerCase();
        return own.indexOf(wanted) >= 0;
      });
    },
    click: (target) => {
      const element = typeof target === 'string' ? resolveElement(target) : target;
      return isElement(element) ? domClick(element) : { clicked: false, reason: 'not found' };
    },
    text: (element, limit) => isElement(element) ? textOf(element, limit || ${MAX_VALUE_CHARS}) : '',
    toolkit: true
  };
  try {
    Object.defineProperty(globalThis, ${JSON.stringify(AGENT_TOOLKIT_GLOBAL)}, {
      value: TOOLKIT, configurable: true, writable: true, enumerable: false
    });
  } catch { globalThis[${JSON.stringify(AGENT_TOOLKIT_GLOBAL)}] = TOOLKIT; }
`
}

/**
 * The point an element is clicked at, and what is over it.
 *
 * Kept with the toolkit because the hit test it uses is the deep one: an element
 * inside a shadow root is reported reachable when the deepest node under the point
 * is the element or inside it, which is the rule the trusted pointer path needs.
 */
export function elementPointSource(): string {
  return `
  const elementPoint = (element) => {
    if (!isElement(element)) return { found: false, reason: 'not found' };
    if (!isVisible(element)) return { found: false, reason: 'the element is not visible' };
    try {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch { element.scrollIntoView(); }
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.x + Math.min(rect.width / 2, Math.max(1, rect.width - 2) / 2));
    const y = Math.round(rect.y + Math.min(rect.height / 2, Math.max(1, rect.height - 2) / 2));
    const hit = deepElementFromPoint(x, y);
    const reachable = hit !== null && containsComposed(element, hit);
    return {
      found: true,
      x,
      y,
      box: boxOf(element),
      coveredBy: reachable
        ? null
        : {
            tag: hit && hit.tagName ? hit.tagName.toLowerCase() : '',
            selector: isElement(hit) ? deepSelector(hit) : '',
            ref: isElement(hit) ? referenceFor(hit) : '',
            label: isElement(hit) ? labelOf(hit) : ''
          }
    };
  };
`
}

/**
 * Click an element through its own DOM method, when a pointer cannot reach it.
 *
 * `HTMLElement.prototype.click` does not exist on an SVG node, so the fallback
 * dispatches the sequence a press is made of instead. Every event is `composed`,
 * because an event that is not composed stops at the shadow boundary and the
 * component that owns the handler never hears it.
 */
export function domClickSource(): string {
  return `
  const domClick = (element) => {
    if (!isElement(element)) return { clicked: false, reason: 'not found' };
    if (element.disabled === true) return { clicked: false, reason: 'the control is disabled' };
    if (element.getAttribute('aria-disabled') === 'true') {
      return { clicked: false, reason: 'the control says it is disabled' };
    }
    if (typeof element.click === 'function') {
      element.click();
      return { clicked: true, via: 'click' };
    }
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, button: 0, detail: 1, isPrimary: true
    };
    const send = (type, extra) => {
      const pointer = type.indexOf('pointer') === 0;
      const init = Object.assign({}, base, extra);
      let event = null;
      // A page's handler sees the same event whether or not the constructor accepts a
      // window reference (an embedded document's own realm is the only one it takes),
      // so a refusal there falls back to the same event without it.
      try {
        event = pointer && typeof PointerEvent === 'function'
          ? new PointerEvent(type, Object.assign({ pointerId: 1, pointerType: 'mouse' }, init))
          : new MouseEvent(type, init);
      } catch {
        try {
          const withoutView = Object.assign({}, init);
          delete withoutView.view;
          event = pointer && typeof PointerEvent === 'function'
            ? new PointerEvent(type, Object.assign({ pointerId: 1, pointerType: 'mouse' }, withoutView))
            : new MouseEvent(type, withoutView);
        } catch { return; }
      }
      element.dispatchEvent(event);
    };
    send('pointerover', { buttons: 0 });
    send('mouseover', { buttons: 0 });
    send('pointerdown', { buttons: 1 });
    send('mousedown', { buttons: 1 });
    send('pointerup', { buttons: 0 });
    send('mouseup', { buttons: 0 });
    send('click', { buttons: 0 });
    return { clicked: true, via: 'events', x, y };
  };
`
}

/**
 * Everything a page script needs, in the order it has to arrive.
 *
 * A script is one expression, so the units are concatenated rather than imported:
 * the toolkit first, then the two helpers that depend on it, then the optional
 * pieces, then the global the caller may want. Every script generated by this
 * module starts here, so a page-side helper is never missing from one of them.
 */
export function pageRuntimeSource(options: PageToolkitOptions = {}): string {
  return [
    pageToolkitSource(options),
    elementPointSource(),
    domClickSource(),
    options.pointerCandidates ? pointerCandidateSource() : '',
    options.install ? toolkitInstallSource() : ''
  ].join('\n')
}
