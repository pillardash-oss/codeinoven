/**
 * The app-owned Android target capability (`cio:adb`).
 *
 * One entry point, `execute(operation, input, context)`, called by the utility
 * gateway for the turn that activated the capability. Everything the caller can
 * do is an operation on a leased target; nothing here is destructive.
 *
 * Design rules this service enforces, each traced to a real failure recorded in
 * `.cio/work/adb-agent-interaction/FINDINGS.md`:
 *
 * - **The lease is mandatory.** Observation included. Two sessions reading and
 *   tapping one phone is what made an earlier session's evidence worthless.
 * - **Every driving call heartbeats the lease**, so a long run does not lose the
 *   target halfway through, and a dead run releases it within the TTL.
 * - **Results are small and redacted.** Node text is omitted unless asked for,
 *   `dump` returns interactive nodes by default, and node lists are capped. A raw
 *   tree dump is the largest single context cost this workflow has.
 */

import { APP_ADB_UTILITY_ID } from '../../lib/utility-ids'
import { ADB_DEFAULT_LEASE_MINUTES, ADB_OPERATIONS, type AdbTextMode } from '../../lib/adb-tool'
import { AdbCommandError, AdbUnavailableError, resetAdbBinary } from './adb-command'
import {
  captureScreen,
  pressKey,
  readStatus,
  reconnect,
  startTarget,
  tapAt,
  typeText,
  type AdbStatus
} from './adb-actions'
import {
  claimTarget,
  describeLease,
  findLeaseForThread,
  heartbeatTarget,
  readTargetLease,
  releaseTarget
} from './adb-lease'
import { invalidateTargetProperties, listTargets, resolveTarget } from './adb-targets'
import { findNodes, readUiTree } from './adb-ui-tree'
import { selectorIsEmpty, type AdbNode, type AdbSelector, type AdbTarget } from './adb-types'

/** Who is asking. Supplied by the gateway, so the service never guesses. */
export interface AdbServiceContext {
  projectId: string
  threadId: string
}

/** Which operations need a live lease. Everything except discovery and recovery. */
const LEASE_FREE_OPERATIONS = new Set(['targets', 'claim', 'reconnect'])

const MAX_NODES_DEFAULT = 120
const MAX_NODES_CEILING = 400
const DEFAULT_WAIT_MS = 10_000
const DEFAULT_POLL_MS = 700

function requireString(value: unknown, name: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`)
  }
  if (value.length > maxLength) throw new Error(`${name} must be at most ${maxLength} characters.`)
  return value
}

function optionalString(value: unknown, name: string, maxLength = 512): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string when provided.`)
  }
  if (value.length > maxLength) throw new Error(`${name} must be at most ${maxLength} characters.`)
  return value
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`${name} must be true or false.`)
  return value
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number.`)
  return parsed
}

function boundedInteger(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = optionalNumber(value, name)
  if (parsed === undefined) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)))
}

function parseTextMode(value: unknown): AdbTextMode {
  if (value === undefined || value === null) return 'omit'
  if (value === 'omit' || value === 'length' || value === 'include') return value
  throw new Error('text must be "omit", "length" or "include".')
}

function parseSelector(input: Record<string, unknown>): AdbSelector {
  const rawSelector = input['selector']
  const source =
    rawSelector && typeof rawSelector === 'object' && !Array.isArray(rawSelector)
      ? (rawSelector as Record<string, unknown>)
      : undefined
  const merged = source ? { ...input, ...source } : input
  delete merged['selector']
  const selector: AdbSelector = {
    resourceId: optionalString(merged['resourceId'], 'resourceId'),
    contentDesc: optionalString(merged['contentDesc'], 'contentDesc'),
    text: optionalString(merged['text'], 'text'),
    textContains: optionalString(merged['textContains'], 'textContains'),
    className: optionalString(merged['className'], 'className'),
    editable: optionalBoolean(merged['editable'], 'editable'),
    clickable: optionalBoolean(merged['clickable'], 'clickable'),
    focused: optionalBoolean(merged['focused'], 'focused'),
    packageName: optionalString(merged['packageName'], 'packageName')
  }
  return selector
}

function selectorNeedsText(selector: AdbSelector): boolean {
  return selector.text !== undefined || selector.textContains !== undefined
}

/** Compact node payload. Long field names, short values: the model reads this. */
interface SerializedNode {
  index: number
  className: string
  resourceId?: string
  contentDesc?: string
  text?: string
  bounds: string
  center: [number, number]
  clickable?: boolean
  editable?: boolean
  focused?: boolean
  scrollable?: boolean
}

function serializeNode(node: AdbNode): SerializedNode {
  const payload: SerializedNode = {
    index: node.index,
    className: node.className,
    bounds: `[${node.bounds.x1},${node.bounds.y1}][${node.bounds.x2},${node.bounds.y2}]`,
    center: [node.center.x, node.center.y]
  }
  if (node.resourceId) payload.resourceId = node.resourceId
  if (node.contentDesc) payload.contentDesc = node.contentDesc
  if (node.text !== null && node.text.length > 0) payload.text = node.text
  if (node.clickable) payload.clickable = true
  if (node.editable) payload.editable = true
  if (node.focused) payload.focused = true
  if (node.scrollable) payload.scrollable = true
  return payload
}

/**
 * Keep the nodes a caller can act on or read.
 *
 * A raw `uiautomator` tree is mostly nested layout containers with no label, no
 * action and no text, and shipping them costs context without adding a fact.
 */
function isInteractiveNode(node: AdbNode): boolean {
  if (node.clickable || node.editable || node.focused || node.scrollable) return true
  if (node.resourceId || node.contentDesc) return true
  if (node.textLength > 0) return true
  return /Button|EditText|TextView|WebView|Dialog|CheckBox|Switch|RadioButton|SeekBar|Image|Tab/iu.test(
    node.className
  )
}

function describeTarget(target: AdbTarget, threadId: string): Record<string, unknown> {
  const lease = readTargetLease(target.serial)
  return {
    serial: target.serial,
    kind: target.kind,
    state: target.state,
    ready: target.ready,
    model: target.model,
    sdk: target.sdk,
    release: target.release,
    size: target.size,
    density: target.density,
    connection: target.kind === 'emulator' ? 'emulator' : (target.usb ?? 'network'),
    leasedByMe: lease?.threadId === threadId,
    leasedBy: lease && lease.threadId !== threadId ? describeLease(lease) : undefined,
    leaseExpiresAt: lease?.expiresAt
  }
}

function serializeStatus(status: AdbStatus): Record<string, unknown> {
  return {
    serial: status.serial,
    awake: status.awake,
    locked: status.locked,
    foregroundPackage: status.foregroundPackage,
    foregroundActivity: status.foregroundActivity,
    keyboardVisible: status.keyboardVisible,
    appProcessId: status.appProcessId,
    size: status.size,
    density: status.density
  }
}

/** Screenshot result shaped as MCP content parts, so the image reaches the model. */
interface AdbToolContent {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
}

export class AdbService {
  /** One operation, dispatched by name. Unknown names fail loudly. */
  async execute(
    operation: string,
    input: Record<string, unknown>,
    context: AdbServiceContext
  ): Promise<unknown> {
    if (!(ADB_OPERATIONS as readonly string[]).includes(operation)) {
      throw new Error(
        `"${operation}" is not an operation of ${APP_ADB_UTILITY_ID}. Use one of ${ADB_OPERATIONS.join(', ')}.`
      )
    }
    try {
      return await this.dispatch(operation, input, context)
    } catch (error) {
      if (error instanceof AdbUnavailableError) {
        throw new Error(
          `${error.message} Checked: ${error.attempted.length > 0 ? error.attempted.join(', ') : 'PATH and the standard SDK locations'}.`,
          { cause: error }
        )
      }
      if (error instanceof AdbCommandError) {
        throw new Error(
          `${error.message}. Reconnect with the reconnect operation if the target dropped.`,
          {
            cause: error
          }
        )
      }
      throw error
    }
  }

  private async dispatch(
    operation: string,
    input: Record<string, unknown>,
    context: AdbServiceContext
  ): Promise<unknown> {
    if (LEASE_FREE_OPERATIONS.has(operation)) {
      return this.runLeaseFree(operation, input, context)
    }
    const lease = this.requireLease(context.threadId)
    heartbeatTarget(lease.serial, context.threadId)
    switch (operation) {
      case 'release':
        releaseTarget(lease.serial, context.threadId)
        invalidateTargetProperties(lease.serial)
        return { released: true, serial: lease.serial }
      case 'status':
        return serializeStatus(await readStatus(lease.serial))
      case 'dump':
        return this.dump(lease.serial, input)
      case 'find':
        return this.find(lease.serial, input)
      case 'tap':
        return this.tap(lease.serial, input)
      case 'type':
        return this.type(lease.serial, input)
      case 'key':
        return { pressed: await pressKey(lease.serial, requireString(input['key'], 'key', 64)) }
      case 'start':
        return this.start(lease.serial, input)
      case 'screenshot':
        return this.screenshot(lease.serial, input)
      case 'wait_for':
        return this.waitFor(lease.serial, input)
      default:
        throw new Error(
          `"${operation}" holds no lease-free path and has no handler. Use one of ${ADB_OPERATIONS.join(', ')}.`
        )
    }
  }

  private async runLeaseFree(
    operation: string,
    input: Record<string, unknown>,
    context: AdbServiceContext
  ): Promise<unknown> {
    if (operation === 'targets') {
      const targets = await listTargets()
      return {
        targets: targets.map((target) => describeTarget(target, context.threadId)),
        note:
          targets.length === 0
            ? 'No Android target is attached. Connect a phone over USB with USB debugging enabled, or boot an emulator.'
            : 'Only a target in the "device" state can be driven. Claim one before using any other operation.'
      }
    }
    if (operation === 'reconnect') {
      const requested = optionalString(input['serial'], 'serial', 256)
      const report = await reconnect(requested)
      resetAdbBinary()
      invalidateTargetProperties(requested)
      return {
        recovered: report.recovered,
        steps: report.steps,
        targets: report.targets.map((target) => describeTarget(target, context.threadId))
      }
    }
    const existing = findLeaseForThread(context.threadId)
    if (existing) {
      throw new Error(
        `This session already holds ${existing.serial}. Release it before claiming another target.`
      )
    }
    const target = await resolveTarget(optionalString(input['serial'], 'serial', 256))
    if (!target.ready) {
      throw new Error(
        `Target ${target.serial} is in the "${target.state}" state and cannot be driven. An "unauthorized" target is showing an RSA prompt on the phone that someone has to accept.`
      )
    }
    const lease = claimTarget({
      serial: target.serial,
      threadId: context.threadId,
      projectId: context.projectId,
      ttlMinutes: boundedInteger(
        input['ttlMinutes'],
        'ttlMinutes',
        ADB_DEFAULT_LEASE_MINUTES,
        1,
        240
      )
    })
    return {
      leased: describeTarget(target, context.threadId),
      lease: { serial: lease.serial, expiresAt: lease.expiresAt, holder: describeLease(lease) },
      status: serializeStatus(await readStatus(lease.serial)),
      note: 'This target is now exclusively yours. Release it when you are done.'
    }
  }

  private requireLease(threadId: string) {
    const lease = findLeaseForThread(threadId)
    if (lease) return lease
    throw new Error(
      `This session holds no target lease. Call targets, then claim, before any other operation. A lease is what stops another session from driving the same phone while you read or tap it.`
    )
  }

  private async dump(serial: string, input: Record<string, unknown>) {
    const textMode = parseTextMode(input['text'])
    const detail = input['detail'] === 'full' ? 'full' : 'interactive'
    const limit = boundedInteger(input['limit'], 'limit', MAX_NODES_DEFAULT, 1, MAX_NODES_CEILING)
    const status = await readStatus(serial)
    const tree = await readUiTree(serial, {
      textMode,
      foregroundPackage: status.foregroundPackage
    })
    const candidates = detail === 'interactive' ? tree.nodes.filter(isInteractiveNode) : tree.nodes
    return {
      foregroundPackage: status.foregroundPackage,
      rotation: tree.rotation,
      nodeCount: tree.nodes.length,
      shown: Math.min(candidates.length, limit),
      truncated: candidates.length > limit,
      attempts: tree.attempts,
      attemptNodeCounts: tree.attemptNodeCounts,
      windows: tree.windows.map((warning) => ({
        kind: warning.kind,
        className: warning.className,
        packageName: warning.packageName
      })),
      caution: tree.caution,
      nodes: candidates.slice(0, limit).map((node) => serializeNode(node))
    }
  }

  private async find(serial: string, input: Record<string, unknown>) {
    const selector = parseSelector(input)
    if (selectorIsEmpty(selector)) {
      throw new Error(
        'Pass at least one selector field: resourceId, contentDesc, text, textContains, className, editable, clickable, focused or packageName.'
      )
    }
    const textMode = parseTextMode(input['text'])
    const limit = boundedInteger(input['limit'], 'limit', 10, 1, 50)
    const status = await readStatus(serial)
    const tree = await readUiTree(serial, {
      textMode,
      selectorNeedsText: selectorNeedsText(selector),
      foregroundPackage: status.foregroundPackage
    })
    const matches = findNodes(tree.nodes, selector, limit)
    return {
      matched: matches.length,
      selector,
      caution: tree.caution,
      matches: matches.map((node) => serializeNode(node))
    }
  }

  private async tap(serial: string, input: Record<string, unknown>) {
    const selector = parseSelector(input)
    const x = optionalNumber(input['x'], 'x')
    const y = optionalNumber(input['y'], 'y')
    if (x !== undefined && y !== undefined) {
      await tapAt(serial, x, y)
      return { tapped: { x: Math.round(x), y: Math.round(y) }, from: 'coordinates' }
    }
    if (x !== undefined || y !== undefined) {
      throw new Error('Pass both x and y, or a selector.')
    }
    if (selectorIsEmpty(selector)) {
      throw new Error('Pass a selector, or both x and y coordinates.')
    }
    const status = await readStatus(serial)
    const tree = await readUiTree(serial, {
      textMode: 'omit',
      selectorNeedsText: selectorNeedsText(selector),
      foregroundPackage: status.foregroundPackage
    })
    const matches = findNodes(tree.nodes, selector, 8)
    const target = matches.find((node) => node.clickable) ?? matches[0]
    if (!target) {
      throw new Error(
        `No node matches ${JSON.stringify(selector)}. Read the screen with dump first, and check the target is foreground (${status.foregroundPackage ?? 'nothing'}).`
      )
    }
    await tapAt(serial, target.center.x, target.center.y)
    return {
      tapped: { x: target.center.x, y: target.center.y },
      from: 'selector',
      node: serializeNode(target),
      ambiguousMatches: matches.length - 1,
      caution:
        matches.length > 1
          ? `The selector also matched ${matches.length - 1} other node(s); the first clickable match was tapped.`
          : tree.caution
    }
  }

  private async type(serial: string, input: Record<string, unknown>) {
    const text = requireString(input['text'], 'text', 8_000)
    const clearFirst = optionalBoolean(input['clearFirst'], 'clearFirst') === true
    const verify = optionalBoolean(input['verify'], 'verify') !== false
    const readBack = verify
      ? async (target: string): Promise<string | null> => {
          const status = await readStatus(target)
          const tree = await readUiTree(target, {
            textMode: 'include',
            foregroundPackage: status.foregroundPackage
          })
          const focused =
            tree.nodes.find((node) => node.editable) ?? tree.nodes.find((node) => node.focused)
          return focused?.text ?? null
        }
      : undefined
    return typeText(serial, text, { clearFirst, readBack })
  }

  private async start(serial: string, input: Record<string, unknown>) {
    const launched = await startTarget(serial, {
      package: optionalString(input['package'], 'package', 256),
      component: optionalString(input['component'], 'component', 256),
      url: optionalString(input['url'], 'url', 2_048)
    })
    const waitForSelector = input['waitForSelector']
    if (waitForSelector && typeof waitForSelector === 'object' && !Array.isArray(waitForSelector)) {
      const selector: AdbSelector = {
        resourceId: optionalString(
          (waitForSelector as Record<string, unknown>)['resourceId'],
          'resourceId'
        ),
        contentDesc: optionalString(
          (waitForSelector as Record<string, unknown>)['contentDesc'],
          'contentDesc'
        ),
        className: optionalString(
          (waitForSelector as Record<string, unknown>)['className'],
          'className'
        )
      }
      if (!selectorIsEmpty(selector)) {
        const waited = await this.waitFor(serial, {
          selector,
          timeoutMs: input['timeoutMs'],
          pollMs: input['pollMs']
        })
        return { ...launched, wait: waited }
      }
    }
    return { ...launched }
  }

  private async screenshot(
    serial: string,
    input: Record<string, unknown>
  ): Promise<AdbToolContent> {
    const maxWidth = boundedInteger(input['maxWidth'], 'maxWidth', 720, 0, 4_000)
    const shot = await captureScreen(serial, maxWidth)
    const status = await readStatus(serial)
    const summary = {
      serial,
      bytes: shot.bytes.length,
      width: shot.width,
      height: shot.height,
      downscaled: shot.downscaled,
      foregroundPackage: status.foregroundPackage,
      keyboardVisible: status.keyboardVisible
    }
    return {
      content: [
        { type: 'text', text: JSON.stringify(summary) },
        { type: 'image', data: shot.bytes.toString('base64'), mimeType: 'image/png' }
      ]
    }
  }

  private async waitFor(serial: string, input: Record<string, unknown>) {
    const selector = parseSelector(input)
    if (selectorIsEmpty(selector)) {
      throw new Error('wait_for needs a selector describing the node to watch for.')
    }
    const state = input['state'] === 'absent' ? 'absent' : 'present'
    const timeoutMs = boundedInteger(input['timeoutMs'], 'timeoutMs', DEFAULT_WAIT_MS, 250, 120_000)
    const pollMs = boundedInteger(input['pollMs'], 'pollMs', DEFAULT_POLL_MS, 250, 5_000)
    const deadline = Date.now() + timeoutMs
    let polls = 0
    let lastCaution: string | null
    for (;;) {
      polls += 1
      const status = await readStatus(serial)
      const tree = await readUiTree(serial, {
        textMode: 'omit',
        selectorNeedsText: selectorNeedsText(selector),
        foregroundPackage: status.foregroundPackage
      })
      lastCaution = tree.caution
      const matches = findNodes(tree.nodes, selector, 1)
      const present = matches.length > 0
      if ((state === 'present' && present) || (state === 'absent' && !present)) {
        return {
          satisfied: true,
          state,
          polls,
          waitedMs: timeoutMs - Math.max(0, deadline - Date.now()),
          foregroundPackage: status.foregroundPackage,
          node: matches[0] ? serializeNode(matches[0]) : undefined,
          caution: lastCaution
        }
      }
      if (Date.now() + pollMs > deadline) {
        return {
          satisfied: false,
          state,
          polls,
          waitedMs: timeoutMs,
          foregroundPackage: status.foregroundPackage,
          caution: lastCaution
            ? `${lastCaution} The condition was not met within ${timeoutMs}ms.`
            : `The condition was not met within ${timeoutMs}ms. Read the screen with dump to see what is actually there.`
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
}

/** Convenience for the lease-free guard, exported for tests. */
export function adbOperationRequiresLease(operation: string): boolean {
  return !LEASE_FREE_OPERATIONS.has(operation)
}
