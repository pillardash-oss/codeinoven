import { shell, systemPreferences, webContents, type WebFrameMain } from 'electron'
import type { Project, Thread } from '../../../lib/types'
import type { BrowserPermissionRequest } from '../../../lib/ipc-contract'
import { Logger } from '../../system/logger'
import { dialogContextScript } from './browser-dialog-context'
import {
  permissionGrantKeys,
  permissionLedgerForPartition,
  permissionOrigin,
  permissionResolutions,
  permissionSilentGrant,
  rememberedPermissionOutcome,
  type PermissionResolution
} from './browser-permissions'
import { type BrowserScreenShareOwner } from './browser-screen-share'
import {
  EXTERNAL_PROTOCOL_PERMISSION,
  externalProtocolTarget,
  type ExternalProtocolTarget
} from '../../../lib/browser/external-protocol'
import {
  type BrowserPageOwner,
  type BrowserTab,
  type PendingBrowserPermission
} from './browser-types'
import {
  MAX_DIALOG_LABEL_LENGTH,
  PERMISSION_TIMEOUT_MS,
  browserPartitionFor
} from './browser-validation'
import type { BrowserService } from '../browser-service'

/**
 * The permission prompts a page raises, and the ledger behind them.
 *
 * Grants and denies are remembered per jar and per origin, promptable once from durable
 * memory, and resolved by the card the user answers. The dialog-context shim that tells
 * a page's own dialogs which site they belong to is part of the same surface, because
 * it is the same question asked in a different place.
 */

/**
 * What `browser-service-permissions` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface PermissionsHost {
  readonly activeTabBounds: BrowserService['activeTabBounds']
  readonly injectedDialogLabels: BrowserService['injectedDialogLabels']
  readonly isViewSourceDocument: BrowserService['isViewSourceDocument']
  readonly pendingPermissions: BrowserService['pendingPermissions']
  readonly permissionDenies: BrowserService['permissionDenies']
  readonly permissionGrants: BrowserService['permissionGrants']
  readonly permissionMemory: BrowserService['permissionMemory']
  readonly projects: BrowserService['projects']
  readonly promptWindow: BrowserService['promptWindow']
  readonly tabForContents: BrowserService['tabForContents']
  readonly tabs: BrowserService['tabs']
  readonly threads: BrowserService['threads']
  readonly window: BrowserService['window']
}

export class BrowserServicePermissions {
  constructor(private readonly host: PermissionsHost) {}

  /** The tab and jar a display-media request's frame belongs to, or null when
   *  the frame is gone or belongs to no tab of this browser. */
  resolveScreenShareOwner(frame: WebFrameMain | null): BrowserScreenShareOwner | null {
    const contents = frame ? webContents.fromFrame(frame) : undefined
    if (!contents || contents.isDestroyed()) return null
    const owner = this.host.tabForContents(contents.id)
    if (!owner) return null
    return {
      tabId: owner.id,
      projectId: owner.tab.projectId,
      partition: browserPartitionFor(owner.tab.projectId, owner.tab.boxId)
    }
  }

  /**
   * Answer a pending request from the durable memory when it already holds the
   * decision, otherwise put the prompt on screen.
   *
   * The prompt is shown after the read, so a permission the user already granted
   * (in this run of another instance, or before a restart) is never asked for
   * again just because this instance's ledgers had not caught up yet.
   */
  async promptFromDurableMemory(id: string): Promise<void> {
    const pending = this.host.pendingPermissions.get(id)
    if (!pending) return
    try {
      await this.host.permissionMemory.refresh(this.permissionLedgers())
    } catch (error: unknown) {
      Logger.error('Browser permission memory could not be refreshed:', error)
    }
    // The user may have answered, or the request may have timed out, while the
    // read was in flight.
    const remaining = this.host.pendingPermissions.get(id)
    if (!remaining) return
    const outcome = rememberedPermissionOutcome(
      permissionGrantKeys(remaining.request),
      this.host.permissionGrants.get(remaining.partition),
      this.host.permissionDenies.get(remaining.partition)
    )
    if (outcome === 'grant') {
      this.resolvePermission(id, permissionSilentGrant)
      return
    }
    if (outcome === 'deny') {
      this.resolvePermission(id, permissionResolutions.dismiss)
      return
    }
    // Native OS popup composites above the WebContentsView: the page stays
    // live and interactive while the prompt is on screen.
    this.showPendingPermission(remaining)
  }

  /** Put one pending request on the prompt card, labelled with its tab. Every
   *  path that raises a prompt shares this, so a permission request and an
   *  external-address handoff draw the same card and cannot drift apart. */
  showPendingPermission(pending: PendingBrowserPermission): void {
    const tab = this.host.tabs.get(pending.request.tabId)
    this.host.promptWindow.show(
      {
        request: pending.request,
        queueSize: this.host.pendingPermissions.size,
        projectLabel: tab ? this.permissionLabel(tab) : null,
        systemAccessDenied: pending.systemAccessDenied
      },
      this.promptAnchor()
    )
  }

  /**
   * Offer a page's external address to the operating system, and answer whether
   * it was one.
   *
   * The address is not opened here: a page must not be able to launch an app on
   * the machine just by pointing a link at it. It goes on the same prompt card a
   * permission request uses, and the OS open happens only after the user
   * confirms it ({@link openExternalUrl}). A caller that gets true must refuse
   * the in-app navigation, because the destination is not a page.
   */
  offerExternalNavigation(
    owner: BrowserPageOwner,
    url: string,
    requestingFrameUrl?: string | null
  ): boolean {
    const target = externalProtocolTarget(url)
    if (!target) return false
    const tab = this.host.tabs.get(owner.tabId)
    if (!tab || this.host.window.webContents.isDestroyed()) return false
    // An embedded frame that asked for the handoff names itself on the card; a
    // main-frame navigation names the page it is on. Only an http(s) requester
    // can ask at all: a page with no origin of its own (a blank document, a
    // dead renderer) has no site to name.
    const origin =
      permissionOrigin(requestingFrameUrl ?? '') ?? permissionOrigin(tab.view.webContents.getURL())
    if (!origin) return false
    const id = crypto.randomUUID()
    const request: BrowserPermissionRequest = {
      id,
      tabId: owner.tabId,
      projectId: owner.projectId,
      origin,
      permission: EXTERNAL_PROTOCOL_PERMISSION,
      mediaTypes: [],
      externalUrl: target.url
    }
    const timer = setTimeout(
      () => this.resolvePermission(id, permissionResolutions.dismiss),
      PERMISSION_TIMEOUT_MS
    )
    const pending: PendingBrowserPermission = {
      request,
      // An external address has no Chromium callback waiting on it: the page's
      // navigation was already refused, and the OS open is the whole outcome.
      callback: () => {},
      timer,
      systemAccessDenied: false,
      partition: browserPartitionFor(owner.projectId, owner.boxId)
    }
    this.host.pendingPermissions.set(id, pending)
    this.showPendingPermission(pending)
    return true
  }

  /** Hand a confirmed external address to the operating system. Only an address
   *  that passed {@link externalProtocolTarget} reaches here, and only after the
   *  user asked for it, so the value handed out is validated twice. */
  openExternalUrl(url: string): void {
    const target: ExternalProtocolTarget | null = externalProtocolTarget(url)
    if (!target) return
    void shell.openExternal(target.url).catch((error: unknown) => {
      Logger.error('Browser external address could not be opened:', error)
    })
  }

  /** The live grant/deny ledgers the permission handlers read and write. */
  permissionLedgers(): {
    grants: Map<string, Set<string>>
    denies: Map<string, Set<string>>
  } {
    return { grants: this.host.permissionGrants, denies: this.host.permissionDenies }
  }

  /** Persist the ledgers after a decision. Writes are rare (one per user
   *  answer), so they go straight to disk and never block the handler. */
  persistPermissionMemory(): void {
    void this.host.permissionMemory.save(this.permissionLedgers()).catch((error: unknown) => {
      Logger.error('Browser permission memory could not be saved:', error)
    })
  }

  /** Dismiss every pending permission prompt that belongs to a project. */
  dismissProjectPermissions(projectId: string): void {
    for (const [requestId, pending] of this.host.pendingPermissions) {
      if (pending.request.projectId === projectId)
        this.resolvePermission(requestId, permissionResolutions.dismiss)
    }
  }

  /** Forget every remembered permission grant or denial for one context: its own
   *  jar, plus any partition the caller is about to remove.
   *
   *  A box's ledger is deliberately not reached from here. A box is one jar for the
   *  whole profile, so clearing one project's decisions must not forget the answers
   *  the personal browser and other projects rely on; a box's own clear action
   *  forgets its ledger when it empties that jar. */
  clearProjectPermissionMemory(projectId: string, extraPartitions: readonly string[] = []): void {
    const partitions = new Set<string>([browserPartitionFor(projectId), ...extraPartitions])
    // The store owns the clear so a permission read already in flight cannot
    // merge the forgotten keys back after the user asked for them to be gone.
    void Promise.all(
      [...partitions].map((partition) =>
        this.host.permissionMemory.forget(partition, this.permissionLedgers())
      )
    ).catch((error: unknown) => {
      Logger.error('Browser permission memory could not be saved:', error)
    })
  }

  /** Apply a manual site-permission decision from the padlock menu. Writes the
   *  same ledger keys the prompt path reads, so the next request from the page
   *  is answered silently: a manual Allow behaves exactly like answering Allow
   *  on the prompt, a Block like Don't allow, and Ask every time forgets only
   *  this origin's keys instead of the whole jar. */
  applySitePermission(
    partition: string,
    keys: readonly string[],
    action: 'allow' | 'block' | 'reset'
  ): void {
    const grants = permissionLedgerForPartition(this.host.permissionGrants, partition)
    const denies = permissionLedgerForPartition(this.host.permissionDenies, partition)
    for (const key of new Set(keys)) {
      if (action === 'allow') {
        denies.delete(key)
        grants.add(key)
      } else if (action === 'block') {
        grants.delete(key)
        denies.add(key)
      } else {
        grants.delete(key)
        denies.delete(key)
      }
    }
    this.persistPermissionMemory()
  }

  /** Reload the tabs in one jar currently showing one origin. A page that
   *  already decided the camera is blocked (Meet's "camera off" state) only
   *  re-queries on navigation, so a manual decision reloads it into the new
   *  answer instead of leaving the stale one on screen. */
  reloadOriginTabs(partition: string, origin: string): void {
    for (const tab of this.host.tabs.values()) {
      if (browserPartitionFor(tab.projectId, tab.boxId) !== partition) continue
      if (!tab.initialNavigationStarted) continue
      const contents = tab.view.webContents
      if (contents.isDestroyed()) continue
      if (permissionOrigin(contents.getURL()) !== origin) continue
      contents.reload()
    }
  }

  resolvePermission(requestId: string, resolution: PermissionResolution): void {
    const pending = this.host.pendingPermissions.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.host.pendingPermissions.delete(requestId)
    if (resolution.rememberDeny) {
      const grants = this.host.permissionGrants.get(pending.partition)
      const denies = this.host.permissionDenies.get(pending.partition)
      for (const key of permissionGrantKeys(pending.request)) {
        grants?.delete(key)
        denies?.add(key)
      }
      this.persistPermissionMemory()
    }
    if (resolution.granted) {
      if (pending.request.externalUrl) {
        this.openExternalUrl(pending.request.externalUrl)
      } else {
        void this.grantBrowserPermission(pending, resolution.rememberGrant)
      }
    } else {
      pending.callback(false)
    }
    this.showNextPermissionPrompt()
  }

  /** Show the next queued request, or drop the prompt when the queue is empty. */
  showNextPermissionPrompt(): void {
    const next = this.host.pendingPermissions.values().next()
    if (next.done) {
      this.host.promptWindow.hide()
      return
    }
    this.showPendingPermission(next.value)
  }

  /** Ask macOS for capture access only after the user allows the site. The
   * browser's callback stays pending while the OS prompt is open, which lets
   * Chromium resume `getUserMedia` only after both decisions have succeeded. */
  async grantBrowserPermission(
    pending: PendingBrowserPermission,
    rememberGrant: boolean
  ): Promise<void> {
    const mediaTypes = pending.request.permission === 'media' ? pending.request.mediaTypes : []
    if (process.platform === 'darwin') {
      try {
        for (const mediaType of new Set(mediaTypes)) {
          const accessType =
            mediaType === 'audio' ? 'microphone' : mediaType === 'video' ? 'camera' : null
          if (accessType && !(await systemPreferences.askForMediaAccess(accessType))) {
            pending.systemAccessDenied = true
            pending.callback(false)
            this.promptSystemAccessDenied(pending)
            return
          }
        }
      } catch (error: unknown) {
        Logger.error('macOS browser media access request failed:', error)
        pending.callback(false)
        return
      }
    }
    if (rememberGrant) {
      const grants = this.host.permissionGrants.get(pending.partition)
      const denies = this.host.permissionDenies.get(pending.partition)
      for (const key of permissionGrantKeys(pending.request)) {
        denies?.delete(key)
        grants?.add(key)
      }
      this.persistPermissionMemory()
    }
    pending.callback(true)
  }

  /** Keep the denied request visible until the user dismisses it or retries. */
  promptSystemAccessDenied(pending: PendingBrowserPermission): void {
    this.showPendingPermission(pending)
  }

  /** Content-anchored placement data for the permission popup: the active tab's
   *  last known view bounds, or nothing when no tab is on screen. */
  promptAnchor(): { x: number; y: number; width: number } | null {
    const bounds = this.host.activeTabBounds
    return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width } : null
  }

  /** Resolve the "<project> - <thread>" context line for a tab's dialogs, or
   *  null when either record is missing (native dialog then stays untouched). */
  dialogLabel(tab: BrowserTab): string | null {
    let project: Project | null
    let thread: Thread | null
    try {
      project = this.host.projects.get(tab.projectId)
      thread = this.host.threads.get(tab.threadId)
    } catch (error: unknown) {
      Logger.error('Browser dialog context lookup failed:', error)
      return null
    }
    if (!project || !thread) return null
    const name = project.name.trim()
    const title = thread.title.trim()
    if (!name || !title) return null
    const label = `${name} - ${title}`
    return label.length > MAX_DIALOG_LABEL_LENGTH
      ? `${label.slice(0, MAX_DIALOG_LABEL_LENGTH)}…`
      : label
  }

  /** Resolve the requester label for permission prompts: "<project> - <thread>"
   *  when both records exist, the project name alone when only the project
   *  does, and null when the request cannot be tied to a project (the popup
   *  then shows just the requesting website). */
  permissionLabel(tab: BrowserTab): string | null {
    let project: Project | null
    let thread: Thread | null
    try {
      project = this.host.projects.get(tab.projectId)
      thread = this.host.threads.get(tab.threadId)
    } catch (error: unknown) {
      Logger.error('Browser permission label lookup failed:', error)
      return null
    }
    if (!project) return null
    const name = project.name.trim()
    const title = thread?.title.trim() ?? ''
    const label = title ? `${name} - ${title}` : name
    if (!label) return null
    return label.length > MAX_DIALOG_LABEL_LENGTH
      ? `${label.slice(0, MAX_DIALOG_LABEL_LENGTH)}…`
      : label
  }

  /** Install the labeled alert/confirm shim into a document's JS context.
   *  Chromium renders page dialogs as native windows parented to the app
   *  window and carries no context about which CodeInOven thread owns the
   *  page, so every loaded frame gets a wrapper that prefixes the dialog
   *  message with "<project> - <thread> <Alert|Confirm>" followed by the
   *  page's own text. Injection is idempotent per document: re-injection
   *  (after thread renames or replays) rewraps the same original callables
   *  instead of stacking prefixes. `prompt()` is left untouched because
   *  Electron never renders it. */
  injectDialogContext(tabId: string, frame?: WebFrameMain): void {
    const tab = this.host.tabs.get(tabId)
    if (!tab) return
    const label = this.dialogLabel(tab)
    if (!label) return
    const script = dialogContextScript(label)
    const contents = tab.view.webContents
    if (this.host.isViewSourceDocument(contents)) return
    if (frame) {
      this.runDialogScript(frame, script)
      return
    }
    // The shim installs itself once per document and rewraps the same original
    // callables on repeat, so a document that already carries this label has
    // nothing to gain from another pass. Callers include the renderer's per-frame
    // alignment reporting, where a repeat is a script evaluation into every frame
    // of the page for no change. A new document clears the record (see the
    // `did-navigate` handler), and a renamed project or thread changes the label,
    // so both still re-install it.
    if (this.host.injectedDialogLabels.get(tabId) === label) return
    let frames: readonly WebFrameMain[]
    try {
      frames = contents.mainFrame.framesInSubtree
    } catch {
      // Between documents there is no frame tree to inject into.
      return
    }
    for (const candidate of frames) this.runDialogScript(candidate, script)
    this.host.injectedDialogLabels.set(tabId, label)
  }

  runDialogScript(frame: WebFrameMain, script: string): void {
    if (frame.isDestroyed()) return
    void frame.executeJavaScript(script).catch(() => {
      // Frames can be replaced mid-navigation; the shim installs on the next
      // frame load, so a failed injection here is harmless.
    })
  }
}
