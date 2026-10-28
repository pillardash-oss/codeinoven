/**
 * The page-side half of the agent's browser operations.
 *
 * Every operation that needs to know something about the document runs one of
 * these expressions through `executeJavaScript` in the page's main world. Keeping
 * them here rather than inline in `browser-service.ts` is deliberate: they are the
 * only part of the agent path that is page code, so they are the only part that can
 * be exercised on its own (see `tests/main/browser/browser-agent-page.test.ts`),
 * and one reference/selector scheme shared by the snapshot and every action is
 * what lets an agent act on what it actually read.
 *
 * Three things this module exists to get right:
 *
 * 1. **A snapshot that describes real elements.** The reference it hands out is an
 *    attribute the page itself carries, so an action minutes later still resolves
 *    the same element, and each element also reports the unique CSS selector a
 *    person would write, its live value and state, and its box on screen.
 * 2. **Typing that a framework accepts.** Setting `element.value` is not typing:
 *    React installs its own value setter on the node instance, so the assignment
 *    updates React's value tracker and the `input` event that follows looks
 *    unchanged, which is exactly how a form ends up looking empty while the tool
 *    reports success. The prototype setter is what leaves the tracker stale, and
 *    the read-back in the result is what makes the outcome verifiable instead of
 *    assumed.
 * 3. **A pointer a person would recognise.** The synthetic cursor is a real node in
 *    the page, marked as the agent's own, so a screenshot shows where the agent is
 *    working and no snapshot mistakes it for page content.
 */

/** The attribute a snapshot reference lives on. Page-side, survives until reload. */
export const AGENT_REF_ATTRIBUTE = 'data-cio-ref'
/**
 * Marks a node the agent's own overlay added, so no snapshot reports it and no
 * action resolves it as page content.
 */
export const AGENT_OWNED_ATTRIBUTE = 'data-cio-agent'

/** Refs one document may hand out, so a busy single-page app cannot exhaust memory. */
const MAX_REFS = 5000
/** Characters of one element's label the snapshot reports. */
const MAX_LABEL_CHARS = 200
/** Characters of one element's value the snapshot reports. */
const MAX_VALUE_CHARS = 400
/** Options a `<select>` reports before it is summarised instead. */
const MAX_OPTIONS = 40
/** Characters of page text the snapshot reports before it is truncated. */
const MAX_TEXT_CHARS = 40000

/**
 * The set of elements a snapshot considers.
 *
 * The role list is page content, not this app's own UI language: it is what other
 * people's forms, menus and toggles actually use, and an agent that cannot see a
 * role-checkbox switch cannot operate the page it was sent to.
 */
const SNAPSHOT_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  'label',
  'canvas',
  'img[alt]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

/**
 * Helpers every script in this module reuses: reference assignment, unique
 * selector construction, visibility, and a compact element description.
 *
 * It is a function returning source rather than an exported constant so the
 * constant strings interpolated into it (attribute names, caps) stay in one place
 * and the tests can evaluate the same text the page receives.
 */
function pageHelpers(): string {
  return `
  const REF_ATTR = ${JSON.stringify(AGENT_REF_ATTRIBUTE)};
  const MARK_ATTR = ${JSON.stringify(AGENT_OWNED_ATTRIBUTE)};
  const ownerNode = (node) => node instanceof Element ? node.closest('[' + MARK_ATTR + ']') : null;
  const cssEscape = (value) => {
    if (globalThis.CSS && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => '\\\\' + character);
  };
  const matchesOne = (selector) => {
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const uniqueSelector = (element) => {
    if (element.id && matchesOne('#' + cssEscape(element.id))) return '#' + cssEscape(element.id);
    for (const attribute of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'placeholder']) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const selector = element.tagName.toLowerCase() + '[' + attribute + '=' + JSON.stringify(value) + ']';
      if (matchesOne(selector)) return selector;
    }
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 10) {
      if (node.id && matchesOne('#' + cssEscape(node.id))) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag);
      node = parent;
    }
    return parts.join(' > ');
  };
  const referenceFor = (element) => {
    const existing = element.getAttribute(REF_ATTR);
    if (existing) return existing;
    globalThis.__cioAgentRefSeq = (globalThis.__cioAgentRefSeq || 0) + 1;
    const reference = 'r' + globalThis.__cioAgentRefSeq;
    if (globalThis.__cioAgentRefSeq <= ${MAX_REFS}) element.setAttribute(REF_ATTR, reference);
    return reference;
  };
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (typeof element.checkVisibility === 'function') {
      try { return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch { return true; }
    }
    return element.getClientRects().length > 0;
  };
  const boxOf = (element) => {
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  };
  const textOf = (element, limit) => {
    const raw = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.value
      : (element.innerText || element.textContent || '');
    return String(raw || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
  };
  const labelOf = (element) => {
    const labels = element.labels ? Array.from(element.labels).map((label) => label.innerText || '').join(' ') : '';
    const label = element.getAttribute('aria-label')
      || (element.getAttribute('aria-labelledby') || '').split(/\\s+/).map((id) => {
        const node = id ? document.getElementById(id) : null;
        return node ? (node.innerText || node.textContent || '') : '';
      }).join(' ')
      || labels
      || element.getAttribute('title')
      || '';
    const own = element instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(element.type) ? element.value : '';
    return String(label || own || textOf(element, ${MAX_LABEL_CHARS}) || '').replace(/\\s+/g, ' ').trim().slice(0, ${MAX_LABEL_CHARS});
  };
  const valueOf = (element) => {
    if (element instanceof HTMLInputElement && element.type === 'password') {
      return { value: '[redacted]', valueLength: (element.value || '').length };
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
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
      options: all.slice(0, ${MAX_OPTIONS}).map((option) => ({ value: option.value, label: (option.text || '').trim().slice(0, 120), selected: option.selected })),
      ...(all.length > ${MAX_OPTIONS} ? { optionsTotal: all.length } : {})
    };
  };
  const describe = (element) => {
    const reference = referenceFor(element);
    const description = {
      ref: reference,
      selector: uniqueSelector(element),
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || '',
      type: element instanceof HTMLInputElement ? (element.type || 'text') : '',
      name: element.getAttribute('name') || '',
      label: labelOf(element),
      visible: isVisible(element),
      box: boxOf(element),
      ...valueOf(element),
      ...optionsOf(element)
    };
    if (element instanceof HTMLInputElement) {
      if (element.type === 'checkbox' || element.type === 'radio') description.checked = element.checked;
      if (element.disabled) description.disabled = true;
      if (element.readOnly) description.readOnly = true;
      if (element.required) description.required = true;
      if (element.accept) description.accept = element.accept;
    }
    if (element instanceof HTMLTextAreaElement) {
      if (element.disabled) description.disabled = true;
      if (element.readOnly) description.readOnly = true;
      if (element.required) description.required = true;
    }
    if (element instanceof HTMLSelectElement && element.disabled) description.disabled = true;
    const href = element.getAttribute('href');
    if (href) description.href = href.slice(0, 500);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) description.placeholder = placeholder.slice(0, 200);
    const aria = element.getAttribute('aria-expanded');
    if (aria) description.expanded = aria === 'true';
    if (element.isContentEditable) description.editable = true;
    return description;
  };
  const resolveElement = (selector) => {
    try {
      const found = document.querySelector(selector);
      return found instanceof HTMLElement ? found : null;
    } catch { return null; }
  };`
}

/** The snapshot request a caller may narrow. */
export interface AgentSnapshotOptions {
  /** Read only elements a person could act on, skipping every bare label. */
  interactiveOnly: boolean
  /** Elements the snapshot reports before it is truncated. */
  maxElements: number
  /** Characters of visible page text the snapshot reports, 0 for none. */
  maxText: number
}

/**
 * Read the page as an agent needs it: the text, plus every element it could act
 * on, each with a reference, a real selector, its live value and its box.
 */
export function agentSnapshotScript(options: AgentSnapshotOptions): string {
  const selector = options.interactiveOnly
    ? SNAPSHOT_SELECTOR.split(', ')
        .filter((part) => !['label', 'canvas', 'img[alt]'].includes(part))
        .join(', ')
    : SNAPSHOT_SELECTOR
  return `(() => {
    ${pageHelpers()}
    const matches = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .filter((element) => element instanceof HTMLElement && !ownerNode(element));
    const elements = matches.slice(0, ${Math.max(1, options.maxElements)}).map(describe);
    const scroller = document.scrollingElement || document.documentElement;
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      text: ${options.maxText > 0 ? `(document.body ? document.body.innerText || '' : '').slice(0, ${Math.min(options.maxText, MAX_TEXT_CHARS)})` : `''`},
      scroll: {
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY),
        height: scroller ? scroller.scrollHeight : 0,
        width: scroller ? scroller.scrollWidth : 0,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      },
      count: matches.length,
      truncated: matches.length > Math.min(elements.length, ${Math.max(1, options.maxElements)}),
      elements
    };
  })()`
}

/**
 * Type into a field the way a person does, and report what actually landed.
 *
 * A framework-controlled input ignores a plain `element.value` assignment (see the
 * module note), so the prototype setter is used and the result is read back.
 * `append` leaves the existing content in place; the default replaces it, which is
 * what a form field means.
 */
export function agentTypeScript(request: {
  selector: string
  text: string
  append: boolean
}): string {
  return `(() => {
    ${pageHelpers()}
    const element = resolveElement(${JSON.stringify(request.selector)});
    if (!element) return { typed: false, reason: 'not found' };
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.disabled) return { typed: false, reason: 'the field is disabled' };
      if (element.readOnly) return { typed: false, reason: 'the field is read-only' };
      if (${JSON.stringify(request.text)} !== '' && element.type === 'file') return { typed: false, reason: 'a file input takes files, not text' };
      element.focus();
      try { element.setSelectionRange(0, element.value ? element.value.length : 0); } catch {}
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      const next = ${request.append ? 'true' : 'false'} ? (element.value || '') + ${JSON.stringify(request.text)} : ${JSON.stringify(request.text)};
      const previous = element.value;
      setter.call(element, next);
      element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ${JSON.stringify(request.text)} }));
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(request.text)} }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      const applied = element.value === next;
      return {
        typed: true,
        applied,
        previousLength: previous ? previous.length : 0,
        length: element.value ? element.value.length : 0,
        ...(element.type === 'password' ? { value: '[redacted]' } : { value: String(element.value || '') }),
        ...(applied ? {} : { reason: 'the field did not keep the text it was given; check its type or its own validation' })
      };
    }
    if (element.isContentEditable || element.getAttribute('contenteditable') !== null) {
      element.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      if (${request.append ? 'true' : 'false'}) range.collapse(false);
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, ${JSON.stringify(request.text)}); } catch { inserted = false; }
      if (!inserted) {
        if (!${request.append ? 'true' : 'false'}) element.textContent = '';
        element.appendChild(document.createTextNode(${JSON.stringify(request.text)}));
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(request.text)} }));
      }
      const after = element.innerText || element.textContent || '';
      return { typed: true, applied: after.includes(${JSON.stringify(request.text)}), value: after.slice(0, ${MAX_VALUE_CHARS}) };
    }
    return { typed: false, reason: 'element is not editable' };
  })()`
}

/** Put the caret in a field, so a following key press lands where the agent means. */
export function agentFocusScript(selector: string): string {
  return `(() => {
    ${pageHelpers()}
    const element = resolveElement(${JSON.stringify(selector)});
    if (!element) return { focused: false, reason: 'not found' };
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const end = element.value ? element.value.length : 0;
      try { element.setSelectionRange(end, end); } catch {}
    }
    return { focused: document.activeElement === element || element.contains(document.activeElement) };
  })()`
}

/** Choose an option (or options) of a select, by value or by visible label. */
export function agentSelectScript(request: {
  selector: string
  value?: string
  label?: string
  values?: string[]
}): string {
  return `(() => {
    ${pageHelpers()}
    const element = resolveElement(${JSON.stringify(request.selector)});
    if (!element) return { selected: false, reason: 'not found' };
    if (!(element instanceof HTMLSelectElement)) return { selected: false, reason: 'element is not a select' };
    if (element.disabled) return { selected: false, reason: 'the select is disabled' };
    const wantedValues = ${JSON.stringify(request.values ?? [])};
    const wantedValue = ${JSON.stringify(request.value ?? '')};
    const wantedLabel = ${JSON.stringify(request.label ?? '')};
    const matches = Array.from(element.options).filter((option) => {
      if (wantedValues.length > 0) return wantedValues.includes(option.value) || wantedValues.includes((option.text || '').trim());
      if (wantedValue) return option.value === wantedValue || (option.text || '').trim() === wantedValue;
      if (wantedLabel) return (option.text || '').trim() === wantedLabel || option.value === wantedLabel;
      return false;
    });
    if (matches.length === 0) {
      return {
        selected: false,
        reason: 'no option matched',
        options: Array.from(element.options).slice(0, ${MAX_OPTIONS}).map((option) => ({ value: option.value, label: (option.text || '').trim().slice(0, 120) }))
      };
    }
    if (!element.multiple) {
      element.value = matches[0].value;
      matches[0].selected = true;
    } else {
      for (const option of Array.from(element.options)) option.selected = matches.includes(option);
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      selected: true,
      value: element.value,
      selectedLabels: Array.from(element.selectedOptions || []).map((option) => (option.text || '').trim())
    };
  })()`
}

/** Tick, untick, or set a checkbox, radio or role switch. */
export function agentCheckScript(request: { selector: string; checked: boolean }): string {
  return `(() => {
    ${pageHelpers()}
    const element = resolveElement(${JSON.stringify(request.selector)});
    if (!element) return { checked: false, reason: 'not found' };
    const target = ${request.checked ? 'true' : 'false'};
    if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
      if (element.checked === target) return { checked: true, state: element.checked, changed: false };
      element.click();
      return { checked: true, state: element.checked, changed: element.checked !== (${request.checked ? 'false' : 'true'}) };
    }
    const role = element.getAttribute('role') || '';
    if (role === 'checkbox' || role === 'switch' || role === 'radio') {
      const current = element.getAttribute('aria-checked') === 'true';
      if (current !== target) element.click();
      return { checked: true, state: element.getAttribute('aria-checked') === 'true', changed: current !== target };
    }
    return { checked: false, reason: 'element is not a checkbox, radio, or switch' };
  })()`
}

/**
 * Where on screen one element is, and whether it is reachable at all.
 *
 * The point is what a real mouse event is aimed at, so it is measured after the
 * element is scrolled into view and it is rejected when something else covers it.
 */
export function agentElementPointScript(selector: string): string {
  return `(() => {
    ${pageHelpers()}
    const element = resolveElement(${JSON.stringify(selector)});
    if (!element) return { found: false, reason: 'not found' };
    if (!isVisible(element)) return { found: false, reason: 'the element is not visible' };
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.x + Math.min(rect.width / 2, Math.max(1, rect.width - 2) / 2));
    const y = Math.round(rect.y + Math.min(rect.height / 2, Math.max(1, rect.height - 2) / 2));
    const hit = document.elementFromPoint(x, y);
    const covered = hit !== null && !element.contains(hit) && !(hit instanceof Element && hit.contains(element));
    return {
      found: true,
      x,
      y,
      box: boxOf(element),
      coveredBy: covered ? { tag: hit ? hit.tagName.toLowerCase() : '', selector: hit instanceof Element ? uniqueSelector(hit) : '' } : null
    };
  })()`
}

/**
 * Click an element through its own DOM method.
 *
 * This is the fallback for an element a pointer cannot reach (hidden behind an
 * overlay, or off screen with no layout), where the page's own handler is still the
 * right thing to run. It is marked as such in the result, because a click that did
 * not go through the input pipeline is not the same evidence as one that did.
 */
export function agentDomClickScript(selector: string): string {
  return `(() => {
    ${pageHelpers()}
    const element = resolveElement(${JSON.stringify(selector)});
    if (!element) return { clicked: false, reason: 'not found' };
    if (element instanceof HTMLInputElement && element.disabled) return { clicked: false, reason: 'the control is disabled' };
    element.click();
    return { clicked: true };
  })()`
}

/** Which element is under one point, as a selector, for review and hit testing. */
export function agentHitTestScript(point: { x: number; y: number }): string {
  return `(() => {
    ${pageHelpers()}
    const hit = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
    if (!(hit instanceof Element)) return null;
    const owned = ownerNode(hit);
    const element = owned ? owned : hit;
    return { selector: uniqueSelector(element), tag: element.tagName.toLowerCase() };
  })()`
}

/** Move the agent's own cursor overlay to a point, and optionally show a press. */
export function agentCursorScript(request: {
  x: number
  y: number
  press: boolean
  hide: boolean
}): string {
  return `(() => {
    const MARK_ATTR = ${JSON.stringify(AGENT_OWNED_ATTRIBUTE)};
    const CURSOR_ID = '__cio-agent-cursor';
    const existing = document.getElementById(CURSOR_ID);
    if (${request.hide ? 'true' : 'false'}) {
      if (existing) existing.remove();
      globalThis.__cioAgentCursor = null;
      return { cursor: false };
    }
    let record = globalThis.__cioAgentCursor;
    if (!record || !existing || existing.getAttribute(MARK_ATTR) !== 'cursor') {
      const host = document.createElement('div');
      host.id = CURSOR_ID;
      host.setAttribute(MARK_ATTR, 'cursor');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;transition:left 90ms linear,top 90ms linear;';
      const pointer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      pointer.setAttribute('width', '18');
      pointer.setAttribute('height', '24');
      pointer.setAttribute('viewBox', '0 0 18 24');
      pointer.style.cssText = 'position:absolute;left:-1px;top:-1px;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5));';
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M1 1 L1 19.2 L5.6 14.9 L8.6 21.6 L11.6 20.2 L8.6 13.7 L14.6 13.1 Z');
      path.setAttribute('fill', '#ffffff');
      path.setAttribute('stroke', '#111111');
      path.setAttribute('stroke-width', '1.3');
      path.setAttribute('stroke-linejoin', 'round');
      pointer.appendChild(path);
      const ring = document.createElement('div');
      ring.style.cssText = 'position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:9999px;border:2px solid #0a84ff;opacity:0;';
      host.appendChild(ring);
      host.appendChild(pointer);
      (document.body || document.documentElement).appendChild(host);
      record = { host, ring };
      globalThis.__cioAgentCursor = record;
    }
    record.host.style.left = ${JSON.stringify(request.x)} + 'px';
    record.host.style.top = ${JSON.stringify(request.y)} + 'px';
    if (${request.press ? 'true' : 'false'}) {
      try {
        record.ring.animate(
          [{ opacity: 0.9, transform: 'scale(0.5)' }, { opacity: 0, transform: 'scale(1.4)' }],
          { duration: 260, easing: 'ease-out' }
        );
      } catch {}
    }
    return { cursor: true, x: ${JSON.stringify(request.x)}, y: ${JSON.stringify(request.y)} };
  })()`
}

/** Scroll one point of the page, or bring an element into view. */
export function agentScrollScript(request: {
  selector?: string
  x?: number
  y?: number
  deltaX: number
  deltaY: number
  to?: 'top' | 'bottom'
}): string {
  return `(() => {
    ${pageHelpers()}
    const selector = ${JSON.stringify(request.selector ?? '')};
    if (selector) {
      const element = resolveElement(selector);
      if (!element) return { scrolled: false, reason: 'not found' };
      ${request.to ? `${JSON.stringify(request.to)} === 'bottom' ? element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }) : element.scrollTo({ top: 0, behavior: 'instant' });` : `element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });`}
      element.scrollBy({ left: ${JSON.stringify(request.deltaX)}, top: ${JSON.stringify(request.deltaY)}, behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      return { scrolled: true, box: boxOf(element), x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    }
    const to = ${JSON.stringify(request.to ?? '')};
    if (to === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
    else if (to === 'bottom') window.scrollTo({ top: (document.scrollingElement || document.documentElement).scrollHeight, behavior: 'instant' });
    else window.scrollBy({ left: ${JSON.stringify(request.deltaX)}, top: ${JSON.stringify(request.deltaY)}, behavior: 'instant' });
    return { scrolled: true, x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
  })()`
}

/**
 * Wait for a page condition, in the page, for a bounded time.
 *
 * It resolves rather than throws on timeout, because "the thing the agent wanted
 * never appeared" is an answer it has to read and act on, not an exception that
 * hides what the page looked like.
 */
export function agentWaitScript(request: {
  selector?: string
  text?: string
  urlIncludes?: string
  gone?: boolean
  visible?: boolean
  timeoutMs: number
}): string {
  const condition = request.selector
    ? `(() => {
        let element = null;
        try { element = document.querySelector(${JSON.stringify(request.selector)}); } catch { element = null; }
        const present = element instanceof HTMLElement;
        ${request.gone ? `return !present;` : request.visible === false ? `return present;` : `return present && isVisible(element);`}
      })()`
    : request.text
      ? `(() => {
          const body = document.body ? (document.body.innerText || '') : '';
          return body.includes(${JSON.stringify(request.text)});
        })()`
      : request.urlIncludes
        ? `location.href.includes(${JSON.stringify(request.urlIncludes)})`
        : `document.readyState === 'complete'`
  return `(() => {
    ${pageHelpers()}
    const timeoutMs = ${JSON.stringify(Math.max(0, Math.min(request.timeoutMs, 30000)))};
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        let matched = false;
        try { matched = ${condition}; } catch { matched = false; }
        if (matched) {
          resolve({ ok: true, matched: true, waitedMs: Date.now() - startedAt, readyState: document.readyState, url: location.href });
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          resolve({ ok: false, matched: false, timedOut: true, waitedMs: Date.now() - startedAt, readyState: document.readyState, url: location.href });
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  })()`
}

/** Run one expression in the page and report its value, or why it threw. */
export function agentEvaluateScript(expression: string): string {
  return `(async () => {
    try {
      const value = await (${expression});
      let summary;
      try { summary = JSON.parse(JSON.stringify(value === undefined ? null : value)); } catch { summary = String(value); }
      return { ok: true, value: summary };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  })()`
}

/** The element's own page-space rectangle, for an element screenshot. */
export function agentElementRectScript(selector: string): string {
  return `(() => {
    ${pageHelpers()}
    const element = resolveElement(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
      box: boxOf(element)
    };
  })()`
}
