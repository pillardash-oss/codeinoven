/**
 * The operations that change or observe a leased Android target: status, taps,
 * typing, key events, launches, screenshots, waits and reconnect.
 *
 * Everything here runs through `runAdb`, which owns the resolved binary and the
 * normalized environment. Nothing in this module shells out through a user PATH,
 * which is the fix for the first finding in
 * `.cio/work/adb-agent-interaction/FINDINGS.md`: every session so far has had to
 * discover `~/Library/Android/sdk/platform-tools/adb` by hand and prefix its
 * commands with an `export PATH=...`.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigRoot } from '../../lib/utils'
import { runAdb, runAdbOn } from './adb-command'
import { invalidateTargetProperties, listTargets } from './adb-targets'
import type { AdbTarget } from './adb-types'

/** Key names accepted by `input keyevent`, kept explicit so a typo fails loudly. */
const KEY_NAMES = [
  'BACK',
  'HOME',
  'APP_SWITCH',
  'ENTER',
  'DEL',
  'TAB',
  'ESCAPE',
  'SPACE',
  'DPAD_UP',
  'DPAD_DOWN',
  'DPAD_LEFT',
  'DPAD_RIGHT',
  'DPAD_CENTER',
  'MOVE_HOME',
  'MOVE_END',
  'PAGE_UP',
  'PAGE_DOWN',
  'VOLUME_UP',
  'VOLUME_DOWN',
  'POWER',
  'WAKEUP',
  'SLEEP',
  'CLEAR',
  'SEARCH'
] as const

/** Screen state, foreground app, keyboard state and geometry for one target. */
export interface AdbStatus {
  serial: string
  awake: boolean
  locked: boolean
  foregroundPackage: string | null
  foregroundActivity: string | null
  topActivity: string | null
  keyboardVisible: boolean
  focusedEditable: boolean
  size: string | null
  density: number | null
  /** Package of the app the caller most likely wants, when one can be told. */
  appProcessId: number | null
}

function parseForeground(output: string): { packageName: string | null; activity: string | null } {
  const window = /mCurrentFocus=Window\{[^}]*?\s([\w.]+)\/([\w.$]+)\}/u.exec(output)
  if (window) return { packageName: window[1]!, activity: window[2]! }
  const resumed = /topResumedActivity=ActivityRecord\{[^}]*?\s([\w.]+)\/([\w.$]+)/u.exec(output)
  if (resumed) return { packageName: resumed[1]!, activity: resumed[2]! }
  return { packageName: null, activity: null }
}

/** Read the target's state. Cheap enough to run before and after every action. */
export async function readStatus(serial: string, expectedPackage?: string): Promise<AdbStatus> {
  const [window, power, input, size, density] = await Promise.all([
    runAdbOn(serial, ['shell', 'dumpsys', 'window']).catch(() => ''),
    runAdbOn(serial, ['shell', 'dumpsys', 'power']).catch(() => ''),
    runAdbOn(serial, ['shell', 'dumpsys', 'input_method']).catch(() => ''),
    runAdbOn(serial, ['shell', 'wm', 'size']).catch(() => ''),
    runAdbOn(serial, ['shell', 'wm', 'density']).catch(() => '')
  ])
  const foreground = parseForeground(window)
  const wakefulness = /mWakefulness=(\w+)/u.exec(power)?.[1] ?? ''
  const sizeMatch = /(?:Override|Physical) size:\s*(\d+x\d+)/iu.exec(size)
  const densityMatch = /density:\s*(\d+)/iu.exec(density)
  let appProcessId: number | null = null
  if (expectedPackage) {
    const pid = await runAdbOn(serial, ['shell', 'pidof', expectedPackage]).catch(() => '')
    const parsed = Number.parseInt(pid.trim().split(/\s+/u)[0] ?? '', 10)
    if (Number.isFinite(parsed)) appProcessId = parsed
  }
  return {
    serial,
    awake: wakefulness === 'Awake',
    locked: /mShowingLockscreen=true|isStatusBarKeyguard=true|mDreamingLockscreen=true/u.test(
      window
    ),
    foregroundPackage: foreground.packageName,
    foregroundActivity: foreground.activity,
    topActivity:
      /topResumedActivity=ActivityRecord\{[^}]*?\s([\w.]+)\/([\w.$]+)/u.exec(window)?.[2] ?? null,
    keyboardVisible: /mInputShown=true/u.test(input),
    focusedEditable:
      /mServedView.*?(EditText|WebView)/u.test(input) || /mInputShown=true/u.test(input),
    size: sizeMatch?.[1] ?? null,
    density: densityMatch ? Number.parseInt(densityMatch[1]!, 10) : null,
    appProcessId
  }
}

/** Wrap a value in single quotes for the device shell, escaping embedded quotes. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`
}

/** Tap a point in physical pixels. */
export async function tapAt(serial: string, x: number, y: number): Promise<void> {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    throw new Error(
      `Tap coordinates must be two non-negative numbers, received x=${String(x)} y=${String(y)}.`
    )
  }
  await runAdb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))], { serial })
}

/**
 * Build the device command that types `text`.
 *
 * `input text` goes through the keyboard, so:
 *
 * - a literal space ends the token and only the first word arrives, which is why
 *   every space becomes `%s` here rather than being passed through,
 * - anything outside printable ASCII is dropped by the IME, so non-ASCII is
 *   refused up front and reported instead of silently disappearing,
 * - the whole payload is single-quoted, so shell metacharacters in a message
 *   cannot turn into device commands.
 */
export function prepareTypedText(text: string): {
  args: string[]
  droppedCharacters: string[]
  newlineCount: number
  warning: string | null
} {
  const droppedCharacters: string[] = []
  let newlineCount = 0
  let sanitized = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (character === '\n' || character === '\r') {
      // A line break cannot be typed by `input text`, and dropping it silently
      // would glue two words into one. It becomes a space, and the caller is
      // told to press ENTER for each break if the line breaks matter.
      newlineCount += 1
      sanitized += ' '
      continue
    }
    if (code < 0x20 || code > 0x7e) {
      if (!droppedCharacters.includes(character)) droppedCharacters.push(character)
      continue
    }
    sanitized += character
  }
  // `%s` is the device's own space escape, so a literal `%s` in the message
  // cannot be typed and has to be reported rather than silently becoming a space.
  const literalEscape = sanitized.includes('%s')
  const payload = sanitized.replace(/ /gu, '%s')
  return {
    args: ['shell', 'input', 'text', shellSingleQuote(payload)],
    droppedCharacters,
    newlineCount,
    warning: literalEscape
      ? 'The text contains the literal sequence "%s", which the device treats as a space and cannot type. Split the operation around it.'
      : null
  }
}

/** Result of one type operation. */
export interface AdbTypeResult {
  typedCharacters: number
  droppedCharacters: string[]
  newlineCount: number
  readBack: string | null
  verified: boolean | null
  warning: string | null
}

/** How many backspaces one clear sends. A composer body is never longer. */
const CLEAR_KEYSTROKES = 200

export async function typeText(
  serial: string,
  text: string,
  options: { clearFirst?: boolean; readBack?: (serial: string) => Promise<string | null> }
): Promise<AdbTypeResult> {
  if (options.clearFirst) {
    // Select-all then delete is the only reliable clear over adb: repeated DEL
    // key events are not, because the field can move the caret. One `input`
    // call carries every key event, so clearing stays a single round trip.
    await runAdb(
      [
        'shell',
        'input',
        'keyevent',
        'KEYCODE_MOVE_END',
        ...new Array<string>(CLEAR_KEYSTROKES).fill('KEYCODE_DEL')
      ],
      { serial }
    )
  }
  const prepared = prepareTypedText(text)
  await runAdb(prepared.args, { serial })
  const warnings: string[] = []
  if (prepared.warning) warnings.push(prepared.warning)
  if (prepared.droppedCharacters.length > 0) {
    warnings.push(
      `The keyboard only carries printable ASCII, so these characters were not typed: ${prepared.droppedCharacters.join(' ')}. Use a clipboard-based route for accents, smart quotes and emoji.`
    )
  }
  if (prepared.newlineCount > 0) {
    warnings.push(
      `${prepared.newlineCount} line break(s) cannot be typed and were replaced with a space. Send a separate \`key\` operation with ENTER for each line break.`
    )
  }
  let readBack: string | null = null
  let verified: boolean | null = null
  if (options.readBack) {
    readBack = await options.readBack(serial)
    if (readBack !== null) {
      const expected = text.replace(/[\r\n]+/gu, ' ').trim()
      verified = readBack.trim() === expected
      if (!verified) {
        warnings.push(
          `The field reads back differently from what was typed. Read back: ${JSON.stringify(readBack.slice(0, 200))}. Clear the field and retype before submitting anything.`
        )
      }
    }
  }
  return {
    typedCharacters: text.length,
    droppedCharacters: prepared.droppedCharacters,
    newlineCount: prepared.newlineCount,
    readBack,
    verified,
    warning: warnings.length > 0 ? warnings.join(' ') : null
  }
}

/** Press one key by name or numeric keycode. */
export async function pressKey(serial: string, key: string): Promise<string> {
  const upper = key.trim().toUpperCase()
  if (/^\d+$/u.test(upper)) {
    await runAdb(['shell', 'input', 'keyevent', upper], { serial })
    return upper
  }
  if (!(KEY_NAMES as readonly string[]).includes(upper)) {
    throw new Error(
      `"${key}" is not a key this capability sends. Use one of ${KEY_NAMES.join(', ')}, or a numeric keycode.`
    )
  }
  await runAdb(['shell', 'input', 'keyevent', `KEYCODE_${upper}`], { serial })
  return upper
}

/** Launch an app, an explicit activity, or a deep link. */
export async function startTarget(
  serial: string,
  request: { package?: string; component?: string; url?: string }
): Promise<{ launched: string }> {
  const targets = [request.package, request.component, request.url].filter(
    (value) => typeof value === 'string' && value.length > 0
  )
  if (targets.length !== 1) {
    throw new Error('Pass exactly one of package, component or url to start.')
  }
  if (request.url) {
    await runAdb(
      [
        'shell',
        'am',
        'start',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        shellSingleQuote(request.url)
      ],
      { serial }
    )
    return { launched: request.url }
  }
  if (request.component) {
    await runAdb(['shell', 'am', 'start', '-n', request.component], { serial })
    return { launched: request.component }
  }
  const packageName = request.package!
  const resolved = await runAdbOn(serial, [
    'shell',
    'cmd',
    'package',
    'resolve-activity',
    '--brief',
    '-c',
    'android.intent.category.LAUNCHER',
    packageName
  ]).catch(() => '')
  const component = resolved
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('/'))
    .pop()
  if (component) {
    await runAdb(['shell', 'am', 'start', '-n', component], { serial })
    return { launched: component }
  }
  // No launcher activity could be resolved; monkey still starts the app.
  await runAdb(
    ['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'],
    { serial, tolerateFailure: true }
  )
  return { launched: packageName }
}

/** One captured screen. */
export interface AdbScreenshot {
  bytes: Buffer
  width: number | null
  height: number | null
  downscaled: boolean
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.toString('latin1', 1, 4) !== 'PNG') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/**
 * Downscale a PNG with the platform image tool when one is available.
 *
 * A raw 1080x2340 screenshot is roughly 300KB, which is about 12K tokens of
 * context for every capture and stays resident for the rest of the turn. That
 * cost is the single largest line item in the session these findings come from,
 * so shrinking it is worth one OS-owned tool at a fixed location.
 */
async function downscalePng(bytes: Buffer, maxWidth: number): Promise<Buffer | null> {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sips')) return null
  const directory = mkdtempSync(join(getConfigRoot(), 'runtime', 'adb-shot-'))
  const input = join(directory, 'in.png')
  const output = join(directory, 'out.png')
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        '/usr/bin/sips',
        ['-s', 'format', 'png', '--resampleWidth', String(maxWidth), input, '--out', output],
        {
          stdio: 'ignore'
        }
      )
      child.on('error', reject)
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`sips exited ${String(code)}`))
      )
    }).catch(() => undefined)
    if (!existsSync(output)) return null
    if (statSync(output).size === 0) return null
    return readFileSync(output)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Capture the target's screen as PNG bytes. */
export async function captureScreen(serial: string, maxWidth?: number): Promise<AdbScreenshot> {
  const result = await runAdb(['exec-out', 'screencap', '-p'], { serial, timeoutMs: 30_000 })
  const dimensions = pngDimensions(result.bytes)
  if (result.bytes.length === 0 || !dimensions) {
    throw new Error(
      'The screen capture came back empty or was not a PNG. The target may be locked or the display may be off.'
    )
  }
  const requested = maxWidth ?? 720
  if (requested > 0 && dimensions.width > requested) {
    const smaller = await downscalePng(result.bytes, requested)
    const smallerDimensions = smaller ? pngDimensions(smaller) : null
    if (smaller && smallerDimensions) {
      return {
        bytes: smaller,
        width: smallerDimensions.width,
        height: smallerDimensions.height,
        downscaled: true
      }
    }
  }
  return {
    bytes: result.bytes,
    width: dimensions.width,
    height: dimensions.height,
    downscaled: false
  }
}

/** One step of the reconnect ladder. */
export interface ReconnectStep {
  step: string
  outcome: string
}

/** The result of a reconnect attempt. */
export interface ReconnectReport {
  recovered: boolean
  steps: ReconnectStep[]
  targets: AdbTarget[]
}

/**
 * Recover an attached target that stopped answering.
 *
 * A real session hit `adb: no devices/emulators found` mid-run and recovered by
 * trial and error: `kill-server` and `start-server` changed nothing, while
 * `reconnect offline` brought the phone back on a new USB address. That ladder is
 * encoded here so the next session does not have to rediscover it.
 */
export async function reconnect(serial?: string): Promise<ReconnectReport> {
  const steps: ReconnectStep[] = []
  const check = async (label: string): Promise<AdbTarget[]> => {
    const targets = await listTargets()
    const wanted = serial
      ? targets.find((target) => target.serial === serial)
      : targets.find((t) => t.ready)
    steps.push({
      step: label,
      outcome:
        targets.length === 0
          ? 'no targets attached'
          : targets.map((t) => `${t.serial} (${t.state})`).join(', ')
    })
    return wanted && wanted.ready ? targets : []
  }

  if ((await check('adb devices -l')).length > 0) {
    return { recovered: true, steps, targets: await listTargets() }
  }
  await runAdb(['reconnect', 'offline'], { tolerateFailure: true })
  if ((await check('adb reconnect offline')).length > 0) {
    invalidateTargetProperties(serial)
    return { recovered: true, steps, targets: await listTargets() }
  }
  if (process.platform === 'darwin' && existsSync('/usr/sbin/ioreg')) {
    const bus = await new Promise<string>((resolve) => {
      const child = spawn('/usr/sbin/ioreg', ['-p', 'IOUSB', '-w0'], {
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const chunks: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.on('error', () => resolve(''))
      child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    const enumerated = /SAMSUNG_Android|Android/iu.test(bus)
    steps.push({
      step: 'USB bus check (ioreg)',
      outcome: enumerated
        ? 'an Android device is still enumerated on the USB bus, so adb lost it rather than the cable'
        : 'no Android device is enumerated on the USB bus, so the cable or the phone is the problem'
    })
  }
  await new Promise((resolve) => setTimeout(resolve, 1500))
  if ((await check('adb devices -l after reconnect')).length > 0) {
    invalidateTargetProperties(serial)
    return { recovered: true, steps, targets: await listTargets() }
  }
  return { recovered: false, steps, targets: await listTargets() }
}
