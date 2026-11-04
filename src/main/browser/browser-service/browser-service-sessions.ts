import { restoreBrowserSessionCookies } from './browser-session-cookies'
import { session, type Session } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BrowserPermissionRequest } from '../../../lib/ipc-contract'
import { Logger } from '../../system/logger'
import { getConfigRoot } from '../../../lib/utils'
import {
  permissionCheckKey,
  permissionGrantKeys,
  permissionLedgerForPartition,
  permissionOrigin,
  permissionResolutions,
  rememberedPermissionOutcome
} from './browser-permissions'
import { PERMISSION_TIMEOUT_MS, browserPartitionFor } from './browser-validation'
import {
  browserIdentityPreload,
  coherentClientHintHeaders,
  toStringHeaders
} from './browser-client-hints'
import type { BrowserService } from '../browser-service'
import { liveWindowContents } from './browser-view-contents'
import { pageHasUserActivation } from './browser-user-activation'

/**
 * The Electron session (the cookie jar) one project's box browses in.
 *
 * A box is a jar: its own storage, its own permissions, its own extensions, its own
 * preload. One session is created and configured per jar, and the identity preload that
 * keeps a page's client hints honest is written once and referenced by every jar.
 */

/**
 * What `browser-service-sessions` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface SessionsHost {
  browserIdentityPreloadPath: BrowserService['browserIdentityPreloadPath']
  readonly configuredSessions: BrowserService['configuredSessions']
  readonly downloads: BrowserService['downloads']
  readonly pendingPermissions: BrowserService['pendingPermissions']
  readonly permissionDenies: BrowserService['permissionDenies']
  readonly permissionGrants: BrowserService['permissionGrants']
  readonly promptFromDurableMemory: BrowserService['promptFromDurableMemory']
  readonly resolvePermission: BrowserService['resolvePermission']
  readonly screenShare: BrowserService['screenShare']
  readonly tabForContents: BrowserService['tabForContents']
  readonly window: BrowserService['window']
}

/**
 * The preload that makes a browser page's view of its own client hints agree with the
 * brand hints its requests carry. Written into the config root on every launch.
 */
export const BROWSER_IDENTITY_PRELOAD_FILE = 'browser-identity-preload.cjs'

/** The id the identity preload is registered under on a jar's session. */
const BROWSER_IDENTITY_PRELOAD_ID = 'codeinoven-browser-identity'

/**
 * The partitions whose passkey listener is already attached.
 *
 * A jar's `Session` belongs to the process, not to the window that configured it.
 * Parking the app to the menu bar and reopening it tears this service down and builds
 * a new one while Electron keeps the very same `Session` objects, so the wiring that
 * a session keeps   an event listener, unlike a handler, is never replaced by being
 * set again   must be attached once per session for the whole run. This set lives at
 * module scope, which outlives every service, so a reopened window cannot stack a
 * second listener on a jar that already answers passkey requests.
 */
const passkeyWiredPartitions = new Set<string>()

export class BrowserServiceSessions {
  constructor(private readonly host: SessionsHost) {}

  sessionForProject(projectId: string, boxId: string | null = null): Session {
    const partition = browserPartitionFor(projectId, boxId)
    const browserSession = session.fromPartition(partition)
    // Every browser context keeps its own login state across app restarts,
    // including thread browsers that use their project's private cookie jar.
    void restoreBrowserSessionCookies(browserSession)
    // Downloads are tracked for the session, not for the window: the window can be
    // parked and rebuilt while a download keeps running, so the manager that owns
    // them registers here once and keeps them across that rebuild. The partition
    // is what the registration is keyed by, because a box's session is shared by
    // every context that picked that box.
    this.host.downloads.watchSession(projectId, browserSession, partition)
    if (this.host.configuredSessions.has(partition)) return browserSession
    // Reuse the ledgers the durable memory loaded: a fresh set here would throw
    // away every decision the user already made, so a site the user allowed in
    // an earlier run would be prompted again the first time it asked.
    const grants = permissionLedgerForPartition(this.host.permissionGrants, partition)
    const denies = permissionLedgerForPartition(this.host.permissionDenies, partition)
    browserSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      const origin = permissionOrigin(requestingOrigin)
      if (!origin) return false
      const key = permissionCheckKey(origin, permission, Reflect.get(details, 'mediaType'))
      // A remembered "Don't allow" wins over any cached grant for the same key.
      return !denies.has(key) && grants.has(key)
    })
    browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const requestingUrl = Reflect.get(details, 'requestingUrl')
      const securityOrigin = Reflect.get(details, 'securityOrigin')
      const origin = permissionOrigin(
        typeof requestingUrl === 'string' && requestingUrl.length > 0
          ? requestingUrl
          : typeof securityOrigin === 'string' && securityOrigin.length > 0
            ? securityOrigin
            : contents.getURL()
      )
      // A popup window's page asks for its own permissions   a camera prompt in a
      // popup is the same decision as one in a tab. The owner tab is what the
      // prompt is labelled with and what a grant is remembered against. It is
      // found by its page rather than by this session's context: a box's jar is
      // configured by whichever context reached it first and then serves every
      // other one, so the tab's own project is what names the request.
      const owner = this.host.tabForContents(contents.id)
      if (!owner || !origin || !liveWindowContents(this.host.window)) {
        callback(false)
        return
      }
      const rawMediaTypes: unknown = Reflect.get(details, 'mediaTypes')
      const mediaTypes = Array.isArray(rawMediaTypes)
        ? rawMediaTypes.filter((value): value is string => typeof value === 'string')
        : []
      // A camera or microphone request is only a request a person made. A page
      // that asks on load   with no click, key press or tap in its document   is
      // asking passively, so it is refused silently instead of putting a device
      // prompt on screen the user never triggered. The answer is the same for a
      // request the ledgers already remember, so this runs before the prompt
      // path rather than around it.
      if (permission === 'media' && mediaTypes.length > 0) {
        void pageHasUserActivation(contents).then((activated) => {
          if (!activated || contents.isDestroyed()) {
            callback(false)
            return
          }
          this.raisePermissionRequest(owner, origin, permission, mediaTypes, partition, callback)
        })
        return
      }
      this.raisePermissionRequest(owner, origin, permission, mediaTypes, partition, callback)
    })
    // Screen sharing needs its own handler on Electron: `getDisplayMedia`
    // rejects with `NotSupportedError` when a session never answers it. The
    // native system picker is preferred where the platform has one, and the
    // permission request handler above has already gated the call, so a
    // remembered refusal refuses the share before any picker can appear.
    browserSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        void this.host.screenShare.handle(request, callback)
      },
      { useSystemPicker: true }
    )
    // A site asking "sign in with a passkey"   a discoverable request, `get()` with an
    // empty `allowCredentials`   makes Electron ask the app which account to use. A
    // request nothing answers is not refused: the ceremony never settles, the page
    // waits on a promise that no prompt will ever resolve, and every later ceremony
    // on that page rejects with "A request is already pending". Google's sign-in is
    // this exact shape, and the Windows Hello prompt it raises belongs to the OS, so
    // the page has no way back from it on its own.
    //
    // The app draws no account picker, so this answers the two cases it can answer
    // honestly instead of leaving both to hang: a request offering exactly one
    // account completes with that account, and a request that would need the user to
    // choose is declined, which lets the site fall back to its own sign-in.
    if (!passkeyWiredPartitions.has(partition)) {
      passkeyWiredPartitions.add(partition)
      browserSession.on('select-webauthn-account', (_event, details, callback) => {
        const chosen =
          details.accounts.length === 1 ? Reflect.get(details.accounts[0], 'credentialId') : null
        Logger.info('Browser passkey account request answered', {
          partition,
          relyingPartyId: details.relyingPartyId,
          offered: details.accounts.length,
          chosen: typeof chosen === 'string'
        })
        callback(typeof chosen === 'string' ? chosen : null)
      })
    }
    // One identity across everything a site can read. The user agent already names a
    // plain Chrome, while Chromium's own client hints and `navigator.userAgentData` name
    // Chromium, so a site that reads both is told two browsers rendered the page: that
    // mismatch is what Google's account pages answer with "This browser or app may not
    // be secure". The hints are rewritten on the way out, and the preload that makes the
    // page's own object agree has to be registered before the jar's first page exists.
    // See `browser-client-hints.ts`.
    const identityPreload = this.installBrowserIdentityPreload(browserSession)
    browserSession.webRequest.onBeforeSendHeaders(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, done) => {
        const rewritten = coherentClientHintHeaders(
          details.requestHeaders,
          process.versions.chrome,
          process.platform
        )
        done({
          requestHeaders: rewritten === null ? details.requestHeaders : toStringHeaders(rewritten)
        })
      }
    )
    Logger.info('Browser jar presents one coherent Chrome identity', {
      partition,
      chromeVersion: process.versions.chrome,
      preload: identityPreload !== null
    })
    this.host.configuredSessions.add(partition)
    return browserSession
  }

  /**
   * Put a page's permission request on the prompt card, or answer it from a
   * decision the ledgers already hold.
   *
   * Split out of the session handler so the media path can first ask whether a
   * person caused the request, without duplicating the remembered-decision gate
   * or the pending queue that every other permission shares.
   */
  private raisePermissionRequest(
    owner: NonNullable<ReturnType<SessionsHost['tabForContents']>>,
    origin: string,
    permission: string,
    mediaTypes: readonly string[],
    partition: string,
    callback: (granted: boolean) => void
  ): void {
    if (!liveWindowContents(this.host.window)) {
      callback(false)
      return
    }
    const id = crypto.randomUUID()
    const request: BrowserPermissionRequest = {
      id,
      tabId: owner.id,
      projectId: owner.tab.projectId,
      origin,
      permission,
      mediaTypes: [...mediaTypes]
    }
    // Electron calls this handler for every request even when the check
    // handler already answered, so the remembered decision is the gate here:
    // a remembered "Don't allow" refuses silently, and a decision that
    // already covers the request grants silently instead of prompting the
    // user for a permission they have given before. The partition is this
    // closure's, so a box answers from its own jar's decisions.
    const outcome = rememberedPermissionOutcome(
      permissionGrantKeys(request),
      this.host.permissionGrants.get(partition),
      this.host.permissionDenies.get(partition)
    )
    if (outcome === 'deny') {
      callback(false)
      return
    }
    if (outcome === 'grant') {
      callback(true)
      return
    }
    const timer = setTimeout(
      () => this.host.resolvePermission(id, permissionResolutions.dismiss),
      PERMISSION_TIMEOUT_MS
    )
    this.host.pendingPermissions.set(id, {
      request,
      callback,
      timer,
      partition,
      systemAccessDenied: false
    })
    // Nothing in this instance's ledgers covers the request, but the durable
    // memory is shared with every other running instance: re-read it before
    // asking, and answer from it when the decision is already there. The
    // pending entry (and its timeout) is live while that read is in flight, so
    // a slow or failed read still ends in the prompt on screen instead of a
    // stranded request.
    void this.host.promptFromDurableMemory(id)
  }

  /**
   * Attach the identity preload to one jar, at most once per session.
   *
   * The registration lives on the `Session`, which outlives the window that made it,
   * while `configuredSessions` is this service's own view and is emptied when the
   * window is parked. So a reopened window reached a jar that still carried the very
   * same script and registering the id again threw `Cannot register preload script
   * with existing ID 'codeinoven-browser-identity'` out of whichever IPC call had
   * asked for that jar   a design thumbnail, a tab open, a preview. Asking the
   * session what it already has makes this idempotent: the same file is left alone,
   * and a script pointing at a file that no longer exists (the config root moved) is
   * swapped for the freshly written one.
   */
  installBrowserIdentityPreload(browserSession: Session): string | null {
    const identityPreload = this.ensureBrowserIdentityPreload()
    if (identityPreload === null) return null
    try {
      const registered = browserSession
        .getPreloadScripts()
        .find((script) => script.id === BROWSER_IDENTITY_PRELOAD_ID)
      if (registered?.filePath === identityPreload) return identityPreload
      if (registered) browserSession.unregisterPreloadScript(BROWSER_IDENTITY_PRELOAD_ID)
      browserSession.registerPreloadScript({
        type: 'frame',
        id: BROWSER_IDENTITY_PRELOAD_ID,
        filePath: identityPreload
      })
    } catch (error: unknown) {
      // The identity preload only keeps a page's own client hints honest. A jar that
      // refuses it is still a usable jar, so this never fails the caller's work.
      Logger.error('The browser identity preload could not be attached:', error)
    }
    return identityPreload
  }

  /**
   * Write the preload a browser page is created with, once per run.
   *
   * The file has to exist before a jar's first page, and `sessionForProject` cannot wait
   * on disk, so this write is synchronous and tiny. Its content comes from the same
   * module that rewrites the request's brand hints, so the page and its headers can
   * never describe the browser differently. See `browser-client-hints.ts`.
   */
  ensureBrowserIdentityPreload(): string | null {
    if (this.host.browserIdentityPreloadPath !== null) return this.host.browserIdentityPreloadPath
    const file = join(getConfigRoot(), BROWSER_IDENTITY_PRELOAD_FILE)
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(
        file,
        browserIdentityPreload({
          chromeVersion: process.versions.chrome,
          platform: process.platform
        }),
        'utf8'
      )
      this.host.browserIdentityPreloadPath = file
      return file
    } catch (error: unknown) {
      Logger.error('The browser identity preload could not be written:', error)
      return null
    }
  }
}
