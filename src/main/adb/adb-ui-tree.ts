/**
 * Reading the accessibility view tree of a leased Android target.
 *
 * Two failures from a real session drive every decision here
 * (`.cio/work/adb-agent-interaction/FINDINGS.md`, finding F4):
 *
 * 1. A single early dump returned 12 nodes for a fully drawn Capacitor app and
 *    the session concluded the WebView was opaque to `uiautomator`. It was not;
 *    the tree had simply not filled in. So a read retries, keeps the richest
 *    attempt, and reports how many attempts it took.
 * 2. That same thin tree contained a native `android.app.AlertDialog`. Chromium
 *    stops publishing nodes for occluded web content, which is the likeliest
 *    cause of the thin read. So a read reports every window it can see, and says
 *    plainly when something is sitting on top of the app.
 *
 * `--compressed` is never used: it strips nodes.
 */

import { runAdb, TREE_COMMAND_TIMEOUT_MS } from './adb-command'
import {
  nodeMatchesSelector,
  parseUiTree,
  type AdbNode,
  type AdbSelector,
  type AdbTextMode,
  type AdbTreeRead,
  type AdbWindowWarning
} from './adb-types'

const DEVICE_TREE_PATH = `/sdcard/.codeinoven-ui-${process.pid}.xml`
/** A focused app screen is never this small; below it, the dump is suspect. */
const SUSPECT_NODE_COUNT = 3
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 350
const NODE_LIMIT = 800

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Read the rotation attribute `uiautomator` writes on the hierarchy element. */
export function parseRotation(xml: string): string {
  const match = /<hierarchy[^>]*rotation="(\d+)"/u.exec(xml)
  return match?.[1] ?? '0'
}

/**
 * Every window above the app, derived from the packages in the tree.
 *
 * A dialog from the app's own package counts: Capacitor and other native layers
 * draw them, and a dialog prunes the web content behind it regardless of which
 * package it belongs to.
 */
export function detectWindows(
  nodes: AdbNode[],
  foregroundPackage: string | null
): AdbWindowWarning[] {
  const warnings: AdbWindowWarning[] = []
  const packages = new Set<string>()
  for (const node of nodes) {
    if (node.packageName) packages.add(node.packageName)
    if (!/dialog/iu.test(node.className)) continue
    warnings.push({
      kind: 'dialog',
      className: node.className,
      packageName: node.packageName,
      summary: `A native dialog (${node.className}) is on screen. Web content behind a dialog is pruned from the accessibility tree, so controls belonging to the app may be missing from this read.`
    })
  }
  if (foregroundPackage) {
    for (const packageName of packages) {
      if (packageName === foregroundPackage) continue
      if (/systemui|launcher/iu.test(packageName)) continue
      warnings.push({
        kind: 'other-package',
        className: '',
        packageName,
        summary: `Nodes from ${packageName} are in the tree while ${foregroundPackage} is foreground, so a window from that package is on top.`
      })
    }
  }
  return warnings
}

/**
 * A WebView with no node nested inside it is the exact shape of the misleading
 * read from the session this capability comes from, so it gets its own caution.
 */
function webViewCaution(nodes: AdbNode[]): string | null {
  for (const node of nodes) {
    if (!/webview/iu.test(node.className)) continue
    const hasDescendant = nodes.some(
      (other) =>
        other.depth > node.depth &&
        other.bounds.y1 >= node.bounds.y1 &&
        other.bounds.y2 <= node.bounds.y2 &&
        other.bounds.x1 >= node.bounds.x1 &&
        other.bounds.x2 <= node.bounds.x2
    )
    if (!hasDescendant) {
      return `The WebView at [${node.bounds.x1},${node.bounds.y1}][${node.bounds.x2},${node.bounds.y2}] has no nodes nested inside it. That is either a page that is still rendering or content pruned because something is on top of it. Read again before concluding the screen has no controls.`
    }
  }
  return null
}

async function dumpOnce(serial: string): Promise<{ xml: string; nodeCount: number }> {
  await runAdb(['shell', 'uiautomator', 'dump', DEVICE_TREE_PATH], {
    serial,
    timeoutMs: TREE_COMMAND_TIMEOUT_MS,
    tolerateFailure: true
  })
  const read = await runAdb(['exec-out', 'cat', DEVICE_TREE_PATH], {
    serial,
    timeoutMs: TREE_COMMAND_TIMEOUT_MS,
    tolerateFailure: true
  })
  const xml = read.stdout
  return { xml, nodeCount: (xml.match(/<node\b/gu) ?? []).length }
}

/** Remove the scratch file the dump wrote on the target. */
async function cleanDeviceFile(serial: string): Promise<void> {
  await runAdb(['shell', 'rm', '-f', DEVICE_TREE_PATH], { serial, tolerateFailure: true })
}

/**
 * Read the tree, retrying while it looks incomplete.
 *
 * The retry keeps the richest attempt rather than the last one, so a read that
 * got worse (a dialog appeared mid-read) never replaces a good result. When a
 * selector needs to see text, parsing runs with text "include" and the caller
 * elides the values it does not want, so a text selector can never silently
 * match nothing.
 */
export async function readUiTree(
  serial: string,
  options: { textMode: AdbTextMode; selectorNeedsText?: boolean; foregroundPackage?: string | null }
): Promise<AdbTreeRead> {
  const attemptNodeCounts: number[] = []
  let best: { nodes: AdbNode[]; xml: string } | null = null
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const { xml, nodeCount } = await dumpOnce(serial)
      attemptNodeCounts.push(nodeCount)
      const nodes = parseUiTree(xml, 'include')
      if (!best || nodes.length > best.nodes.length) best = { nodes, xml }
      // A healthy screen answers in one dump. Only a suspiciously small tree is
      // worth retrying, which keeps the common case cheap.
      if (nodeCount > SUSPECT_NODE_COUNT) break
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt)
    }
  } finally {
    await cleanDeviceFile(serial)
  }

  const raw = best?.nodes ?? []
  const nodes = raw.slice(0, NODE_LIMIT).map((node) => {
    if (options.textMode === 'include') return node
    if (options.textMode === 'length')
      return { ...node, text: node.textLength > 0 ? `(${node.textLength} chars)` : '' }
    return { ...node, text: null }
  })
  const windows = detectWindows(raw, options.foregroundPackage ?? null)
  const cautions: string[] = []
  if (raw.length <= SUSPECT_NODE_COUNT) {
    cautions.push(
      `The tree held only ${raw.length} node(s) after ${attemptNodeCounts.length} attempt(s) (${attemptNodeCounts.join(', ')}). Do not conclude from this read that the screen has no controls.`
    )
  }
  if (attemptNodeCounts.length > 1) {
    cautions.push(
      `The tree grew between attempts (${attemptNodeCounts.join(', ')}), so this read retried until it settled.`
    )
  }
  cautions.push(...windows.map((warning) => warning.summary))
  const webView = webViewCaution(raw)
  if (webView) cautions.push(webView)
  if (options.textMode !== 'include' && raw.some((node) => node.textLength > 0)) {
    cautions.push(
      'Node text was elided from this result by default. Re-run with text "include" if the text itself is what you need.'
    )
  }

  return {
    nodes,
    attempts: attemptNodeCounts.length,
    attemptNodeCounts,
    rotation: parseRotation(best?.xml ?? ''),
    windows,
    caution: cautions.length > 0 ? cautions.join(' ') : null
  }
}

/** Nodes matching a selector, in tree order, capped at `limit`. */
export function findNodes(nodes: AdbNode[], selector: AdbSelector, limit: number): AdbNode[] {
  const matches: AdbNode[] = []
  for (const node of nodes) {
    if (nodeMatchesSelector(node, selector)) matches.push(node)
    if (matches.length >= limit) break
  }
  return matches
}
