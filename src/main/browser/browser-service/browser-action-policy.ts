import { pageRuntimeSource } from './browser-agent-page/page-toolkit'

/**
 * What a browser mutation acts on. Page labels are evidence, never permission: the
 * app never blocks an action, it only reports what changed afterwards.
 */
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

/**
 * Read only the selected control, never scan a whole page for each action.
 *
 * The read goes through the same deep resolver every action uses, so the control a
 * mutation acts on is the control that will be affected: an element inside a shadow
 * root, an SVG icon, and a node a redraw replaced are all readable here for the same
 * reason they are actionable. A read that answered "not found" for those was a check
 * that could not see what it was reporting on.
 */
export function browserActionTargetScript(selector: string): string {
  return `(() => {
    ${pageRuntimeSource()}
    const selected = resolveElement(${JSON.stringify(selector)});
    if (!isElement(selected)) return null;
    const element = selected.closest('a, button, input, textarea, select, [role="button"], [role="tab"], [role="searchbox"], [role="combobox"]') || selected;
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    const form = element.form || (element.closest ? element.closest('form') : null);
    // One label, not three spellings of it: the accessible name already answers with
    // the aria-label, so only a placeholder it does not carry is added.
    const name = accessibleNameOf(element);
    const placeholder = element.getAttribute('placeholder') || '';
    const label = [name, placeholder && name.indexOf(placeholder) < 0 ? placeholder : '']
      .filter(Boolean)
      .join(' ')
      .trim();
    return {
      tag,
      type: element.type || '',
      role: (element.getAttribute('role') || '').toLowerCase(),
      label: label.slice(0, 300),
      name: element.getAttribute('name') || '',
      href: element.href || '',
      download: element.hasAttribute('download'),
      expanded: element.hasAttribute('aria-expanded'),
      formMethod: element.hasAttribute('formmethod') ? element.formMethod : (form && form.method) || '',
      formAction: element.hasAttribute('formaction') ? element.formAction : (form && form.action) || ''
    };
  })()`
}
