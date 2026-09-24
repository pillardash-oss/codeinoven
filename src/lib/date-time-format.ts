/**
 * The app's canonical date and time presentation.
 *
 * CodeInOven is an English-only workstation, and it pins `en-US` for the values
 * it renders: money through `formatMoney`, list ordering through `DataTable`.
 * Dates follow the same rule, so one timestamp reads the same on every machine.
 *
 * A bare `toLocaleString()` does the opposite. It falls back to the runtime's
 * default for the machine's locale, which is the numeric, seconds-bearing
 * `9/23/2026, 8:05:00 AM` shape, so the same panel reads differently on two
 * machines and a timestamp in a tooltip loses its seconds the moment the app is
 * translated. Every absolute date the app shows goes through this module.
 *
 * Only the locale is pinned. The time zone stays the user's own, so a timestamp
 * still means "then, in your local day".
 */

/** The locale every date and time the app renders is written in. */
export const APP_LOCALE = 'en-US'

const DATE_TIME = new Intl.DateTimeFormat(APP_LOCALE, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

const DATE_ONLY = new Intl.DateTimeFormat(APP_LOCALE, { dateStyle: 'medium' })

const TIME_ONLY = new Intl.DateTimeFormat(APP_LOCALE, {
  hour: 'numeric',
  minute: '2-digit'
})

/** `Sep 23, 2026, 8:05 AM` - an absolute date with its time of day. */
export function formatDateTime(value: Date | number): string {
  return DATE_TIME.format(value)
}

/** `Sep 23, 2026` - an absolute date with no time of day. */
export function formatDate(value: Date | number): string {
  return DATE_ONLY.format(value)
}

/** `8:05 AM` - a time of day on its own. */
export function formatTime(value: Date | number): string {
  return TIME_ONLY.format(value)
}
