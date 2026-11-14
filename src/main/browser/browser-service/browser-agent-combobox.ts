import { asObject } from './browser-service-common'

/**
 * Choosing an option from a picker that is not a `<select>`.
 *
 * A portal's region or resource-group field is an input that owns a listbox and
 * filters it as you type. Nothing typed into it is a value: it is a query, and the
 * value exists only once an option is clicked. This module holds the judgement that
 * turns a query and the list the control offered into the one option to click, kept
 * pure and apart so it can be reasoned about without a page.
 */

/** One option a combobox reported, as the choice is made from it. */
export interface ComboboxOption {
  ref: string
  label: string
  value: string
  selected: boolean
  disabled: boolean
}

/**
 * The options a combobox read reported.
 *
 * A script result crosses a process boundary, so nothing about its shape is trusted:
 * an option without a reference cannot be clicked, and is dropped rather than guessed
 * at.
 */
export function comboboxOptions(state: Record<string, unknown> | null): ComboboxOption[] {
  const reported = state?.['options']
  if (!Array.isArray(reported)) return []
  const options: ComboboxOption[] = []
  for (const entry of reported) {
    const record = asObject(entry)
    const ref = record?.['ref']
    if (typeof ref !== 'string' || ref.length === 0) continue
    options.push({
      ref,
      label: typeof record?.['label'] === 'string' ? record['label'] : '',
      value: typeof record?.['value'] === 'string' ? record['value'] : '',
      selected: record?.['selected'] === true,
      disabled: record?.['disabled'] === true
    })
  }
  return options
}

/**
 * The option a query names, judged the way a person reads a list.
 *
 * An exact label or value wins, then a label that starts with the query, then one that
 * contains it, so a query short enough to match several options still picks the one a
 * person would. Nothing is chosen when nothing matches: a picker's first option is not
 * an answer to a question it did not contain, and choosing it would be the same
 * invented value this path exists to stop.
 */
export function pickComboboxOption(
  options: ComboboxOption[],
  query: string
): ComboboxOption | null {
  const usable = options.filter((option) => !option.disabled)
  if (usable.length === 0) return null
  const wanted = query.trim().toLowerCase()
  if (!wanted) return usable.find((option) => option.selected) ?? usable[0] ?? null
  const rank = (option: ComboboxOption): number => {
    const label = option.label.trim().toLowerCase()
    const value = option.value.trim().toLowerCase()
    if (label === wanted || value === wanted) return 0
    if (label.startsWith(wanted) || value.startsWith(wanted)) return 1
    if (label.includes(wanted) || value.includes(wanted)) return 2
    return 3
  }
  let best: ComboboxOption | null = null
  for (const option of usable) {
    const score = rank(option)
    if (score === 3) continue
    if (!best || score < rank(best)) best = option
  }
  return best
}
