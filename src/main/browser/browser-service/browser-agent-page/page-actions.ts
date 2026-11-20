/**
 * Acting on a page: the form controls, the click, and the reads that report what
 * actually happened.
 *
 * The rule every script here follows is that a page is not fooled by a script. A
 * framework-controlled input ignores a plain value assignment (React installs its
 * own setter, so the assignment updates the tracker and the following `input` event
 * looks unchanged, which is how a form ends up looking empty while a tool reports
 * success), so the prototype setter is used and the result is read back. An SVG node
 * has no `click()`, so the DOM fallback dispatches the composed sequence a press is
 * made of. And a control inside a shadow root is resolved through the deep toolkit,
 * because no plain selector can reach it.
 */

import { MAX_OPTIONS, MAX_VALUE_CHARS, pageRuntimeSource } from './page-toolkit'

/**
 * Type into a field the way a person does, and report what actually landed.
 *
 * `append` leaves the existing content in place; the default replaces it, which is
 * what a form field means.
 */
export function agentTypeScript(request: {
  selector: string
  text: string
  append: boolean
}): string {
  return `(() => {
    ${pageRuntimeSource()}
    const element = resolveElement(${JSON.stringify(request.selector)});
    if (!element) return { typed: false, reason: 'not found' };
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    if ((tag === 'input' || tag === 'textarea') && element.ownerDocument === document) {
      if (element.disabled) return { typed: false, reason: 'the field is disabled' };
      if (element.readOnly) return { typed: false, reason: 'the field is read-only' };
      if (${JSON.stringify(request.text)} !== '' && element.type === 'file') return { typed: false, reason: 'a file input takes files, not text' };
      element.focus();
      try { element.setSelectionRange(0, element.value ? element.value.length : 0); } catch {}
      const prototype = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      const setter = descriptor && descriptor.set;
      const next = ${request.append ? 'true' : 'false'} ? (element.value || '') + ${JSON.stringify(request.text)} : ${JSON.stringify(request.text)};
      const previous = element.value;
      if (setter) setter.call(element, next); else element.value = next;
      element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: 'insertText', data: ${JSON.stringify(request.text)} }));
      element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ${JSON.stringify(request.text)} }));
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
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
    if (element.isContentEditable || element.getAttribute('contenteditable') !== null || element.getAttribute('role') === 'textbox') {
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
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ${JSON.stringify(request.text)} }));
      }
      const after = element.innerText || element.textContent || '';
      return { typed: true, applied: after.includes(${JSON.stringify(request.text)}), value: after.slice(0, ${MAX_VALUE_CHARS}) };
    }
    return { typed: false, reason: 'element is not editable' };
  })()`
}

/**
 * Make a field ready for real keystrokes.
 *
 * Typing like a hand means the field must hold the caret where those keys go, so this
 * focuses it and either selects what is already there (a replace: the first key
 * overwrites the selection) or collapses to the end (an append). Nothing is written
 * here; the keys that follow are the only thing that changes the value.
 */
export function agentPrepareTypingScript(request: { selector: string; append: boolean }): string {
  return `(() => {
    ${pageRuntimeSource()}
    const element = resolveElement(${JSON.stringify(request.selector)});
    if (!element) return { ok: false, reason: 'not found' };
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    if ((tag === 'input' || tag === 'textarea') && element.ownerDocument === document) {
      if (element.disabled) return { ok: false, reason: 'the field is disabled' };
      if (element.readOnly) return { ok: false, reason: 'the field is read-only' };
      if (element.type === 'file') return { ok: false, reason: 'a file input takes files, not text' };
      element.focus();
      const end = element.value ? element.value.length : 0;
      try { element.setSelectionRange(${request.append ? 'end, end' : '0, end'}); } catch {}
      return {
        ok: true,
        editable: true,
        kind: tag,
        selected: ${request.append ? '0' : 'end'},
        previousLength: end
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
      return { ok: true, editable: true, kind: 'contenteditable', selected: ${request.append ? '0' : '1'} };
    }
    return { ok: false, reason: 'element is not editable' };
  })()`
}

/** Read back what a field holds now, for a result that reports the outcome. */
export function agentFieldValueScript(selector: string): string {
  return `(() => {
    ${pageRuntimeSource()}
    const element = resolveElement(${JSON.stringify(selector)});
    if (!element) return { found: false };
    const masked = element.tagName && element.tagName.toLowerCase() === 'input' && element.type === 'password';
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    const raw =
      (tag === 'input' || tag === 'textarea')
        ? String(element.value || '')
        : String(element.innerText || element.textContent || '');
    return {
      found: true,
      masked,
      length: raw.length,
      value: masked ? '[redacted]' : raw.slice(0, ${MAX_VALUE_CHARS})
    };
  })()`
}

/** Put the caret in a field, so a following key press lands where the agent means. */
export function agentFocusScript(selector: string): string {
  return `(() => {
    ${pageRuntimeSource()}
    const element = resolveElement(${JSON.stringify(selector)});
    if (!element) return { focused: false, reason: 'not found' };
    if (typeof element.focus === 'function') element.focus();
    else if (element.scrollIntoView) element.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (element.tagName && (element.tagName.toLowerCase() === 'input' || element.tagName.toLowerCase() === 'textarea')) {
      const end = element.value ? element.value.length : 0;
      try { element.setSelectionRange(end, end); } catch {}
    }
    const active = document.activeElement;
    return {
      focused: active === element || containsComposed(element, active),
      active: active && active.tagName ? active.tagName.toLowerCase() : ''
    };
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
    ${pageRuntimeSource()}
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
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return {
      selected: true,
      value: element.value,
      selectedLabels: Array.from(element.selectedOptions || []).map((option) => (option.text || '').trim())
    };
  })()`
}

/**
 * Open a combobox and report the options it offers.
 *
 * A portal's picker is not a `<select>`: it is an input or a button that owns a
 * listbox, filters it as you type, and keeps nothing you typed unless you choose an
 * option. This reads that shape so the caller can choose like a person does, and it
 * stamps each option with a reference, so the option is clicked through the same
 * path as any other element. The list is searched across shadow roots and in every
 * layer, because a component usually draws it somewhere else entirely.
 */
export function agentComboboxScript(request: {
  selector: string
  open: boolean
  refPrefix?: string
}): string {
  return `(() => {
    ${pageRuntimeSource({ refPrefix: request.refPrefix })}
    const element = resolveElement(${JSON.stringify(request.selector)});
    if (!element) return { found: false };
    const role = (element.getAttribute('role') || '').toLowerCase();
    const popup = (element.getAttribute('aria-haspopup') || '').toLowerCase();
    const host = element.closest('[role="combobox"]');
    const combobox =
      role === 'combobox' ||
      popup === 'listbox' || popup === 'tree' || popup === 'grid' || popup === 'dialog' ||
      element.hasAttribute('aria-autocomplete') ||
      element.hasAttribute('aria-controls') ||
      host !== null;
    if (${request.open ? 'true' : 'false'}) {
      element.focus();
      element.click();
      // A field's own click normally opens its list. The wrapper is only pressed when
      // the control still reports itself closed, because pressing both would toggle the
      // list twice and close what the first press opened.
      if (element.getAttribute('aria-expanded') !== 'true') {
        const control = element.closest('button, [role="combobox"]');
        if (control && control !== element) control.click();
      }
    }
    const owns = (element.getAttribute('aria-controls') || element.getAttribute('aria-owns') || '')
      .split(/\\s+/).filter(Boolean)
      .map((id) => deepById(id))
      .filter((node) => isElement(node) && isVisible(node));
    const scope = element.closest('[role="dialog"], dialog, form, [role="search"]') || document;
    const query = '[role="listbox"], [role="tree"], [role="grid"], select, datalist';
    // A portal draws its list in a layer it appends to the document, often outside
    // the dialog the field belongs to, so a scoped search is only the first look.
    const candidates = [];
    const consider = (node) => {
      if (isElement(node) && isVisible(node) && candidates.indexOf(node) < 0) candidates.push(node);
    };
    for (const node of owns) consider(node);
    for (const node of (scope.querySelectorAll ? Array.from(scope.querySelectorAll(query)) : [])) consider(node);
    for (const node of deepQueryAll(query)) consider(node);
    const listbox = candidates[0] || null;
    const options = [];
    if (listbox) {
      // The options may be drawn inside the listbox's own shadow root, so the list is
      // read through it rather than from the listbox alone.
      const scopes = [listbox];
      for (let index = 0; index < scopes.length && index < 64; index += 1) {
        if (scopes[index].shadowRoot) scopes.push(scopes[index].shadowRoot);
      }
      const all = [];
      for (const scope of scopes) {
        let nodes = [];
        try {
          nodes = Array.from(scope.querySelectorAll('[role="option"], [role="treeitem"], option, li'));
        } catch { nodes = []; }
        for (const node of nodes) {
          if (!isElement(node) || !isVisible(node) || all.indexOf(node) >= 0) continue;
          all.push(node);
        }
      }
      for (const node of all) {
        if (options.length >= ${MAX_OPTIONS}) break;
        const isOption = node instanceof HTMLOptionElement;
        options.push({
          ref: referenceFor(node),
          label: labelOf(node),
          value: node.getAttribute('data-value') || node.getAttribute('value') || (isOption ? node.value : ''),
          selected:
            node.getAttribute('aria-selected') === 'true' ||
            node.getAttribute('aria-checked') === 'true' ||
            (isOption && node.selected),
          disabled:
            node.getAttribute('aria-disabled') === 'true' || (isOption && node.disabled)
        });
      }
    }
    const expandedAttribute = element.getAttribute('aria-expanded');
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    const text =
      tag === 'input' || tag === 'textarea'
        ? String(element.value || '').slice(0, ${MAX_VALUE_CHARS})
        : textOf(element, ${MAX_VALUE_CHARS});
    return {
      found: true,
      combobox,
      expanded: expandedAttribute === 'true' || listbox !== null,
      listbox: listbox !== null,
      value: text,
      options
    };
  })()`
}

/**
 * Every open listbox this document shows, with the options it offers.
 *
 * A picker's list is not always in the document its field is in: a portal blade
 * lives in a frame while the layer the list is drawn in belongs to the page around
 * it. Reading listboxes document by document is what lets the caller find the list
 * wherever it was drawn, and every option carries a reference its own frame names, so
 * the one that matched can be clicked where it actually is.
 */
export function agentListboxOptionsScript(request: { refPrefix?: string }): string {
  return `(() => {
    ${pageRuntimeSource({ refPrefix: request.refPrefix })}
    const boxes = deepQueryAll('[role="listbox"], [role="tree"], [role="menu"], datalist').filter(isVisible);
    const options = [];
    for (const box of boxes) {
      const scopes = [box];
      for (let index = 0; index < scopes.length && index < 64; index += 1) {
        if (scopes[index].shadowRoot) scopes.push(scopes[index].shadowRoot);
      }
      const found = [];
      for (const scope of scopes) {
        let nodes = [];
        try {
          nodes = Array.from(scope.querySelectorAll('[role="option"], [role="treeitem"], [role="menuitem"], option, li'));
        } catch { nodes = []; }
        for (const node of nodes) {
          if (!isElement(node) || !isVisible(node) || found.indexOf(node) >= 0) continue;
          found.push(node);
        }
      }
      for (const option of found.slice(0, ${MAX_OPTIONS})) {
        const isOption = option instanceof HTMLOptionElement;
        options.push({
          ref: referenceFor(option),
          label: labelOf(option),
          value: option.getAttribute('data-value') || option.getAttribute('value') || (isOption ? option.value : ''),
          selected:
            option.getAttribute('aria-selected') === 'true' ||
            option.getAttribute('aria-checked') === 'true' ||
            (isOption && option.selected),
          disabled:
            option.getAttribute('aria-disabled') === 'true' ||
            (isOption && option.disabled)
        });
      }
    }
    return { listboxes: boxes.length, options };
  })()`
}

/**
 * Set the files of a file input from inside its own document.
 *
 * A file input in a cross-origin frame is not reachable from the page's debugger
 * session, so its files are built in the frame itself from bytes the main process
 * read. Nothing about the local path reaches the page, and the change travels as the
 * events a person's own choice would fire.
 */
export function agentFileInputScript(request: {
  selector: string
  files?: Array<{ name: string; type: string; base64: string }>
}): string {
  const files = request.files ?? []
  return `(() => {
    ${pageRuntimeSource()}
    const element = resolveElement(${JSON.stringify(request.selector)});
    if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
      return { available: false };
    }
    if (${files.length > 0 ? 'true' : 'false'}) {
      if (element.disabled) return { available: true, disabled: true };
      const transfer = new DataTransfer();
      for (const file of ${JSON.stringify(files)}) {
        const binary = atob(file.base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        transfer.items.add(new File([bytes], file.name, { type: file.type || 'application/octet-stream' }));
      }
      element.files = transfer.files;
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return {
        available: true,
        multiple: element.multiple,
        accept: element.accept,
        disabled: false,
        attached: element.files ? element.files.length : 0
      };
    }
    return {
      available: true,
      multiple: element.multiple,
      accept: element.accept,
      disabled: element.disabled
    };
  })()`
}

/** Tick, untick, or set a checkbox, radio or role switch. */
export function agentCheckScript(request: { selector: string; checked: boolean }): string {
  return `(() => {
    ${pageRuntimeSource()}
    const element = resolveElement(${JSON.stringify(request.selector)});
    if (!element) return { checked: false, reason: 'not found' };
    const target = ${request.checked ? 'true' : 'false'};
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    if (tag === 'input' && (element.type === 'checkbox' || element.type === 'radio')) {
      if (element.checked === target) return { checked: true, state: element.checked, changed: false };
      const before = element.checked;
      domClick(element);
      return { checked: true, state: element.checked, changed: element.checked !== before };
    }
    const role = element.getAttribute('role') || '';
    if (role === 'checkbox' || role === 'switch' || role === 'radio' || role === 'menuitemcheckbox') {
      const current = element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-pressed') === 'true';
      if (current !== target) domClick(element);
      const after = element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-pressed') === 'true';
      return { checked: true, state: after, changed: current !== target };
    }
    return { checked: false, reason: 'element is not a checkbox, radio, or switch' };
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
    ${pageRuntimeSource()}
    const element = resolveElement(${JSON.stringify(selector)});
    if (!element) return { clicked: false, reason: 'not found' };
    const outcome = domClick(element);
    return Object.assign({}, outcome, { via: 'dom.' + (outcome.via || 'click') });
  })()`
}

/** Which element is under one point, as a selector, for review and hit testing. */
export function agentHitTestScript(point: { x: number; y: number }): string {
  return `(() => {
    ${pageRuntimeSource()}
    const hit = deepElementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
    if (!isElement(hit)) return null;
    const owned = OWNED(hit);
    const element = owned ? owned : hit;
    return {
      selector: deepSelector(element),
      ref: referenceFor(element),
      tag: element.tagName ? element.tagName.toLowerCase() : '',
      label: labelOf(element)
    };
  })()`
}
