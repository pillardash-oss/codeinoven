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
 *
 * The clock is always the 12-hour one the pinned locale names (`8:05 AM`). A
 * locale that happens to prefer 24-hour time, or a machine configured for it,
 * never reaches the user, so a schedule stored as `08:05` is never printed as
 * `08:05`.
 */

/** The locale every date and time the app renders is written in. */
export const APP_LOCALE = 'en-US'

const DATE_TIME = new Intl.DateTimeFormat(APP_LOCALE, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

const DATE_ONLY = new Intl.DateTimeFormat(APP_LOCALE, { dateStyle: 'medium' })

const DATE_COMPACT = new Intl.DateTimeFormat(APP_LOCALE, { month: 'short', day: 'numeric' })

const DATE_TIME_COMPACT = new Intl.DateTimeFormat(APP_LOCALE, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

const DATE_TIME_WEEKDAY = new Intl.DateTimeFormat(APP_LOCALE, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

const TIME_ONLY = new Intl.DateTimeFormat(APP_LOCALE, {
  hour: 'numeric',
  minute: '2-digit'
})

/** Reads a clock off a UTC instant, so a stored time never shifts with the
 *  user's zone or a daylight-saving transition on the reference day. */
const TIME_OF_DAY = new Intl.DateTimeFormat(APP_LOCALE, {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC'
})

/** `Sep 23, 2026, 8:05 AM` - an absolute date with its time of day. */
export function formatDateTime(value: Date | number): string {
  return DATE_TIME.format(value)
}

/** `Sep 23, 8:05 AM` - the compact date with its time of day, for dense chrome
 *  where the year is noise. */
export function formatDateTimeCompact(value: Date | number): string {
  return DATE_TIME_COMPACT.format(value)
}

/** `Tue, Sep 23, 8:05 AM` - the compact date plus its weekday, for a time the
 *  user has to place in their week. */
export function formatDateTimeWithWeekday(value: Date | number): string {
  return DATE_TIME_WEEKDAY.format(value)
}

/** `Sep 23, 2026` - an absolute date with no time of day. */
export function formatDate(value: Date | number): string {
  return DATE_ONLY.format(value)
}

/** `8:05 AM` - a time of day on its own. */
export function formatTime(value: Date | number): string {
  return TIME_ONLY.format(value)
}

/** The local calendar day a moment falls on, as `year-month-day` in the
 *  user's own zone. Comparing two of these answers "same day?" without any
 *  elapsed-milliseconds arithmetic, which is what breaks across a
 *  daylight-saving transition. */
function localDayKey(value: number): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** `Sep 23` in the reference year, `Sep 23, 2025` in any other one, so a date
 *  never leaves the reader guessing which year it belongs to. */
function dayStamp(value: number, reference: number): string {
  return new Date(value).getFullYear() === new Date(reference).getFullYear()
    ? DATE_COMPACT.format(value)
    : DATE_ONLY.format(value)
}

/**
 * The stamp a conversation message carries.
 *
 * Today reads as a bare clock (`8:05 AM`), because the day is obvious in a
 * thread the user is living in. Any other day leads with its real date
 * (`Sep 22, 8:05 AM`, plus the year once it differs), so a thread that spans
 * several days, or one reopened a week later, never shows a message without
 * the day it was sent or received.
 */
export function formatMessageTimestamp(
  value: Date | number,
  now: Date | number = Date.now()
): string {
  const timestamp = typeof value === 'number' ? value : value.getTime()
  if (!Number.isFinite(timestamp)) return ''
  const reference = typeof now === 'number' ? now : now.getTime()
  const clock = formatTime(timestamp)
  return localDayKey(timestamp) === localDayKey(reference)
    ? clock
    : `${dayStamp(timestamp, reference)}, ${clock}`
}

/**
 * The stamp a dense list row carries: `Now`, `5m`, `23h`, `6d`, and then the
 * real day (`Sep 16`, `Sep 16, 2025`) once the age passes a week.
 *
 * An age past a week is where `2w` and `3mo` stop telling an operator anything,
 * so the ladder hands over to the date the moment it stops being precise.
 */
export function formatCompactAge(value: Date | number, now: Date | number = Date.now()): string {
  const timestamp = typeof value === 'number' ? value : value.getTime()
  if (!Number.isFinite(timestamp)) return ''
  const reference = typeof now === 'number' ? now : now.getTime()
  const minutes = Math.floor((reference - timestamp) / 60_000)
  if (minutes < 1) return 'Now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return dayStamp(timestamp, reference)
}

/**
 * `8:05 AM` - a time of day stored in the machine format `HH:mm`.
 *
 * Schedule times are persisted as `HH:mm` because that is what the scheduler
 * compares and sorts. It is not a clock the user should ever read, so every
 * label built from a stored time goes through here. A value that is not a valid
 * `HH:mm` is returned untouched, so a malformed entry still shows what was
 * stored instead of `Invalid Date`.
 */
export function formatTimeOfDay(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return value
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return value
  return TIME_OF_DAY.format(Date.UTC(2000, 0, 1, hours, minutes))
}
