/**
 * Waiting on a page, and the escape hatch that runs the caller's own code in it.
 *
 * A wait resolves rather than throws on timeout, because "the thing the agent wanted
 * never appeared" is an answer it has to read and act on, not an exception that hides
 * what the page looked like. And `evaluate` is worth far more than a raw eval: the
 * deep DOM toolkit is published on the page's global as `__cio` before the expression
 * runs, so an expression can reach inside shadow roots, resolve a reference a
 * snapshot reported, read a floating layer, or describe an element, with the same
 * helpers every operation uses.
 */

import { MAX_VALUE_CHARS, pageRuntimeSource } from './page-toolkit'

/**
 * Longest one in-page wait may hold, in milliseconds.
 *
 * A wait used to stop at 30 s, which is shorter than the pause before a support
 * reply: an agent polling a live conversation had to spend a model step per
 * half minute and usually gave up instead. Two minutes keeps a poll loop cheap
 * and still finishes well inside the engine's five-minute silence watchdog, so
 * a patient wait can never be mistaken for a dead session.
 */
export const BROWSER_WAIT_MAX_TIMEOUT_MS = 120_000

/** How often a `changed` wait re-reads the page: text comparison is the cost. */
const CHANGED_POLL_INTERVAL_MS = 400

/**
 * The text one `changed` wait compares between polls.
 *
 * It is scoped to the selector when one is given (a message list, a thread
 * container) and to the whole page otherwise, so a wait can watch the part of a
 * live conversation that actually carries the reply.
 */
function waitSignatureSource(selector: string | undefined): string {
  return selector
    ? `(() => {
        let element = null;
        try { element = document.querySelector(${JSON.stringify(selector)}); } catch { element = null; }
        return element instanceof HTMLElement ? (element.innerText ?? element.textContent ?? '') : '';
      })`
    : `(() => { const body = document.body; return body ? (body.innerText ?? body.textContent ?? '') : ''; })`
}

/**
 * Wait for a page condition, in the page, for a bounded time.
 *
 * `changed` is the condition a live conversation needs: instead of naming text it
 * cannot know in advance, the caller waits for the visible text to become
 * different from what it was when the wait started. The reply it is waiting for
 * is exactly that change.
 */
export function agentWaitScript(request: {
  selector?: string
  text?: string
  urlIncludes?: string
  gone?: boolean
  visible?: boolean
  changed?: boolean
  timeoutMs: number
}): string {
  const timeoutMs = JSON.stringify(
    Math.max(0, Math.min(request.timeoutMs, BROWSER_WAIT_MAX_TIMEOUT_MS))
  )
  if (request.changed) {
    return `(() => {
      ${pageRuntimeSource()}
      const timeoutMs = ${timeoutMs};
      const readSignature = ${waitSignatureSource(request.selector)};
      const baseline = (() => { try { return readSignature(); } catch { return ''; } })();
      const startedAt = Date.now();
      return new Promise((resolve) => {
        const check = () => {
          let current = baseline;
          try { current = readSignature(); } catch { current = baseline; }
          if (current !== baseline) {
            resolve({ ok: true, matched: true, changed: true, waitedMs: Date.now() - startedAt, readyState: document.readyState, url: location.href });
            return;
          }
          if (Date.now() - startedAt >= timeoutMs) {
            resolve({ ok: false, matched: false, changed: false, timedOut: true, waitedMs: Date.now() - startedAt, readyState: document.readyState, url: location.href });
            return;
          }
          setTimeout(check, ${CHANGED_POLL_INTERVAL_MS});
        };
        check();
      });
    })()`
  }
  const condition = request.selector
    ? `(() => {
        let element = null;
        try { element = deepQuery(${JSON.stringify(request.selector)}); } catch { element = null; }
        const present = isElement(element);
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
    ${pageRuntimeSource()}
    const timeoutMs = ${timeoutMs};
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

/**
 * Run one expression in the page and report its value, or why it threw.
 *
 * The expression runs with `__cio` on the page's global: the same deep DOM helpers
 * the operations use, so `__cio.deep('field').value`, `__cio.ref('r7')`,
 * `__cio.layers()` and `__cio.describe(el)` all work here. It is an expression rather
 * than a function body on purpose: the caller's own script keeps its own last-value
 * semantics, and a promise is awaited.
 */
export function agentEvaluateScript(expression: string): string {
  return `(async () => {
    ${pageRuntimeSource({ install: true })}
    const summarise = (value) => {
      if (value === undefined) return null;
      if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
      if (typeof value === 'string') return value.slice(0, ${MAX_VALUE_CHARS * 8});
      if (isElement(value)) {
        try { return { element: deepSelector(value), ref: referenceFor(value) }; } catch { return '[element]'; }
      }
      try {
        const encoded = JSON.stringify(value);
        if (encoded !== undefined) return JSON.parse(encoded);
      } catch { /* a cyclic or exotic value is described instead */ }
      try { return String(value); } catch { return '[value]'; }
    };
    try {
      const value = await (${expression});
      return { ok: true, value: summarise(value) };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  })()`
}
