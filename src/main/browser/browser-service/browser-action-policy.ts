/** Conservative, app-owned review of browser actions. Page labels are evidence,
 * never permission: only recognizable browsing controls get the fast path. */
export interface BrowserActionTarget {
  tag: string
  type: string
  role: string
  label: string
  name: string
  href: string
  download: boolean
  expanded: boolean
  formMethod: string
  formAction: string
}

export interface BrowserActionReview {
  approved: boolean
  risk: 'low' | 'medium' | 'high'
  reason: string
}

const consequential =
  /\b(delete|remove|destroy|erase|wipe|purchase|buy|pay|checkout|order|send|publish|deploy|submit|save|confirm|authorize|approve|grant|revoke|reset|unsubscribe|logout|update|execute|install|share|sign[ -]?out)\b/iu
const sensitive =
  /\b(password|passwd|secret|token|credential|api[ _-]?key|credit|card|payment|ssn)\b/iu
const browsing =
  /^(?:open|show|view|expand|collapse|menu|more|next|previous|back|forward|search|filter|sort|close|cancel)(?:\b|$)/iu

function browsingUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password &&
      !consequential.test(
        decodeURIComponent(`${url.pathname} ${url.search}`).replace(/[/_+=&-]/gu, ' ')
      )
    )
  } catch {
    return false
  }
}

export function reviewBrowserAction(
  operation: string,
  input: Record<string, unknown>,
  target: BrowserActionTarget | null
): BrowserActionReview {
  const allow = (reason: string): BrowserActionReview => ({ approved: true, risk: 'low', reason })
  const ask = (reason: string, risk: 'medium' | 'high' = 'medium'): BrowserActionReview => ({
    approved: false,
    risk,
    reason
  })
  if (operation === 'viewport' || operation === 'reload') {
    return allow('Routine browser presentation or reload action.')
  }
  if (operation === 'navigate') {
    return typeof input.url === 'string' && browsingUrl(input.url)
      ? allow('Navigation to an ordinary web page.')
      : ask('This destination may perform an account or consequential action.', 'high')
  }
  if (!target) return ask('The browser target could not be inspected.')
  const description = `${target.label} ${target.name}`
  if (consequential.test(description) || sensitive.test(`${description} ${target.type}`)) {
    return ask(
      'This control may change data, send information, or access sensitive fields.',
      'high'
    )
  }
  const searchField =
    target.type === 'search' ||
    target.role === 'searchbox' ||
    /^(?:q|query|search|search_query)$/iu.test(target.name)
  if (operation === 'type') {
    return target.tag === 'input' &&
      (target.type === 'text' || target.type === 'search') &&
      searchField
      ? allow('Enter a search query without submitting a consequential form.')
      : ask('Editing this field may autosave or transmit data.')
  }
  if (operation === 'click') {
    if (target.tag === 'a' && !target.download && browsingUrl(target.href))
      return allow('Follow an ordinary web link.')
    const submits =
      target.tag === 'input'
        ? target.type === 'submit' || target.type === 'image'
        : target.tag === 'button' && target.type === 'submit'
    if (submits) {
      return target.formMethod === 'get' &&
        /\bsearch\b/iu.test(target.label) &&
        browsingUrl(target.formAction)
        ? allow('Submit a search using a GET form.')
        : ask('Submitting this form may send information or change data.', 'high')
    }
    if (
      searchField ||
      target.role === 'tab' ||
      target.expanded ||
      ((target.tag === 'button' || target.role === 'button') && browsing.test(target.label))
    ) {
      return allow('Operate a browsing, search, or navigation control.')
    }
  }
  return ask('The effect of this browser control is not known.')
}

/** Read only the selected control, never scan a whole page for each action. */
export function browserActionTargetScript(selector: string): string {
  return `(() => {
    const selected = document.querySelector(${JSON.stringify(selector)});
    if (!(selected instanceof HTMLElement)) return null;
    const element = selected.closest('a, button, input, textarea, select, [role="button"], [role="tab"], [role="searchbox"]') || selected;
    const form = element.form || element.closest('form');
    return {
      tag: element.tagName.toLowerCase(),
      type: element.type || '',
      role: element.getAttribute('role') || '',
      label: [element.getAttribute('aria-label'), element.innerText || element.textContent, element.getAttribute('placeholder'), element instanceof HTMLInputElement && ['submit', 'button'].includes(element.type) ? element.value : ''].filter(Boolean).join(' ').trim().slice(0, 300),
      name: element.getAttribute('name') || '',
      href: element.href || '',
      download: element.hasAttribute('download'),
      expanded: element.hasAttribute('aria-expanded'),
      formMethod: element.hasAttribute('formmethod') ? element.formMethod : form?.method || '',
      formAction: element.hasAttribute('formaction') ? element.formAction : form?.action || ''
    };
  })()`
}
