# Embedded Browser Architecture Assessment

## Decision

Build an optional, manually operated browser workspace, but do **not** copy or mount a user's live Chrome, Edge, Firefox, or Safari profile.

The maintainable design is a main-process-owned `WebContentsView` using a dedicated persistent Electron session. The view is created only when the user opens Browser, is destroyed when the browser workspace is closed, and has no preload or access to CodeInOven IPC. Users sign in normally inside that isolated profile. Bookmarks may be imported from standard bookmark exports; raw cookie, password, and whole-profile import are deliberately out of scope for the first release.

This is feasible without weakening the agent workspace, but “zero resource use while browsing” is not possible: a real dashboard executes JavaScript and consumes memory, CPU, GPU, network, and disk. The enforceable target is zero browser renderer/runtime cost while the feature is unused, bounded and observable cost while active, and prompt teardown when closed.

### Scoping as implemented

This document is the original assessment; the shipped browser differs from it in one
material way, and the difference is deliberate.

- **One persistent Electron session per project**, `persist:codeinoven-browser:<projectId>`
  (`src/main/browser/browser-service.ts`). A project's conversations therefore share
  cookies, web storage and logins, which is what keeps the user signed in across
  threads, routines and agent runs. Splitting the session per agent would be the only
  way to give each agent its own cookie jar, and it would break that single sign-on,
  so it is not done.
- **Agent-to-agent isolation lives at the tab level**, which is where clashes actually
  happen:
  - The agent's target tab is addressed per `(projectId, threadId)` (`agentTabIds`), so
    two threads never drive the same page.
  - For hidden conversation containers (the inbox and the assistant space) the sidebar
    tab list is scoped to the open conversation, so a background routine's tabs never
    surface in another conversation and cannot be closed from there.
  - Closing a thread destroys exactly that thread's tabs (`browser:destroyThread`).
- **Popup windows are a global-browser feature.** The personal browser hosts a page's
  `window.open` in a view its right rail shows, one tab per popup
  (`src/main/browser/browser-service/browser-popup-windows.ts`, see *Popup windows*
  below). A project's browser and every page an agent drives keep the older behaviour,
  where an opened window is a tab, because those surfaces have no rail to show a popup
  in and an agent's pages must stay addressable.
- **The global browser's tab list is durable app state, owned by main.** It lives in an
  atomically written JSON file under the config root
  (`state/global-browser-tabs.json`, written by
  `src/main/browser/global-browser-tabs-store.ts`) and crosses the IPC contract as
  `browser:loadTabs` / `browser:saveTabs`. It deliberately does **not** live in the
  renderer's `localStorage`: that storage is scoped to the renderer origin and silently
  degrades to an empty, process-local storage whenever another app instance already
  holds the profile's storage database, so a second instance read no tabs, saved none,
  and the next launch restored nothing without a single error being raised.

Treat the rest of this document as the target-state design; the points above describe the
shipped behavior.

## Why this fits the current application

- CodeInOven already treats Electron main as the privileged boundary and keeps the Svelte renderer sandboxed, context-isolated, and without Node integration (`src/main/index.ts:690-719`).
- The main app already validates external navigation, denies popups, and prevents the application renderer from navigating away (`src/main/index.ts:766-786`). The browser needs its own policy rather than weakening these controls.
- The default application session denies web permissions and downloads (`src/main/index.ts:883-894`). A browser must use a separate session so website permissions never change the application renderer's security posture.
- Optional services are loaded after first paint (`src/main/index.ts:309-328`), and the computer-use monitor already creates its external client only on demand and disposes it (`src/main/computer-use-pip-service.ts:131-168`). The browser should follow a stricter version of this lifecycle.
- The existing secret vault keeps plaintext credentials in main only (`src/main/secret-vault.ts:23-54`). Browser cookies must likewise never cross into Svelte state, logs, diagnostics, agent prompts, or repository files.
- Browser should become a first-class `MainView`, not a special case inside a project/thread component. The current navigation union and recovery allowlist are centralized (`src/renderer/lib/stores/renderer-recovery.ts:24-37,111-134`).

Electron recommends `WebContentsView` for remote content and discourages the `<webview>` tag. `BrowserView` is deprecated. A dedicated Electron session provides separate cookies, cache, and web storage without sharing the app's default session. For this app, create it with `session.fromPath(...)` at an absolute path beneath the CodeInOven config root and pass that `Session` to the view; this keeps browser state inside the product's canonical storage boundary instead of Electron's unrelated default `userData` path.

## Trust boundaries

Treat every loaded website, iframe, service worker, download, and popup as hostile to CodeInOven even when the user trusts the brand.

```text
Svelte application renderer
        │ typed, validated browser-control IPC (metadata only)
        ▼
BrowserWorkspaceService in Electron main
        │ owns lifecycle, bounds, navigation policy, prompts, audit events
        ▼
WebContentsView (sandboxed, no preload, no Node, no CodeInOven IPC)
        │
        └── dedicated session.fromPath(config/browser/profiles/<profile-id>)
              cookies / cache / IndexedDB / service workers under app config
```

There must be no bridge from remote page JavaScript to privileged application APIs. Renderer-facing events may contain only safe metadata such as URL, title, loading state, favicon reference, navigation capability, crash state, and permission-prompt details. They must never contain cookie values, authorization headers, local/session storage, page HTML, form contents, or password values.

## Mandatory security controls

### Remote-content process

- `WebContentsView`, not `<webview>` or deprecated `BrowserView`.
- `nodeIntegration: false`, `sandbox: true`, `contextIsolation: true`, `webSecurity: true`.
- No preload script at all for arbitrary sites. In particular, never reuse the application preload.
- DevTools disabled in production unless a later, explicitly gated diagnostic mode is approved.
- Never bypass TLS/certificate failures. Never enable mixed content, Blink experiments, or arbitrary extensions.
- Deny navigation schemes other than `https:`. A separately gated development preference may allow `http:` only for loopback hosts.
- Block `file:`, `javascript:`, `data:`, `blob:` as top-level destinations, `devtools:`, `chrome:`, custom external protocols, and filesystem access by default.
- Validate top-level navigation and redirects in main. The address bar is untrusted input and must be parsed with `URL`, not accepted through prefix checks.
- Handle `window.open` in main. Safe HTTPS popups become controlled tabs or an explicit same-profile child surface; unsupported/external protocols require a user confirmation and are opened by the OS only after validation.

### Popup windows

A page's `window.open(url, name, features)` is a popup window, not a tab: a sign-in, a checkout, a share dialog. The browser hosts it itself, in a `WebContentsView` the browser rail shows, so a popup is a panel of the browser the user is already in rather than an operating-system window that can hide behind the app or land on another screen. Only the global (personal) browser hosts popups this way; a project's browser and every page an agent drives keep the older behaviour, where an opened window is a tab with an address the user can see and steer.

- The hosting hook is Electron's own: `setWindowOpenHandler` answers `{ action: 'allow', createWindow }` for a `new-window` disposition, and the hook is handed the `WebContents` Chromium created for the popup. That one is presented by the app; the native window is never created.
- Presenting that exact `WebContents` is what keeps the popup a real popup: `window.opener` and `window.opener.postMessage` reach the opening page, the popup inherits the opener's session so the cookies a sign-in just set are the ones the page around it already has, and the opener closing destroys what it opened.
- The popup closes itself: `window.close()` (what every completed sign-in and checkout calls) destroys the popup's own `WebContents`, the app is told, and the panel drops the tab. Closing the tab that opened it does the same.
- Adopting the `WebContents` of a popup Electron created as a *window* is refused (`options.webContents is already attached to a window`), which is why the native window is never created in the first place.
- A popup starts at `about:blank` legitimately (a checkout writes its own form into the new window), so that one document is allowed alongside the `https:` the browser navigates to; everything else is refused.
- A popup is a second native view over a DOM panel, so the same visibility rules apply to it as to a tab's page: a full-window DOM surface, the thread switcher or an overlay over the panel keeps it off screen, and hiding it parks it offscreen instead of pausing it.
- The rail carries one tab per popup, in its own single-row strip (`BrowserPopupWindowContextTab`): the tab *is* the window, so a window that ends stops appearing and its tab leaves the strip with it. Each tab closes its own window, the rail's far-right close ends every window the page on screen opened, and the tool closes itself with the last window rather than sitting there as an empty strip.
- The rail animates the width of its own track with a plain CSS transition (`src/renderer/lib/components/browser/BrowserView.svelte`), the same motion the workspace rail's track makes. It must not go back to a Svelte `css` transition: those wait for a zero-duration dummy animation's `finish` event before the real animation starts, and a renderer whose window is not visible never sends that event, which pinned the rail at its first keyframe   `width: 0`   and left the page beside it half open until the view remounted.
- The rail's popup panel places the popup's page by following the frame while the track opens, and re-follows it when the window becomes visible again, because a rail that opened while the window was in the background resumes its opening when the user comes back.
- Install permission request and permission check handlers on the browser session. Default deny; prompt for the exact origin and permission; support Allow once, Always allow for this site, and Deny. Start with camera, microphone, geolocation, notifications, HID, serial, USB, MIDI, screen capture, and filesystem access denied.
- Prevent silent downloads. A download always goes through the native save dialog and a safe filename, never lands in the repository by itself, and stays visible with progress and an explicit open/reveal action. See "Downloads" below for what happens when one is stopped, cancelled or left running at a quit.
- Redact browser URLs/query strings from general logs and diagnostics. Sensitive page titles should not enter agent context or telemetry.

### Session and profile storage

- Use a dedicated persistent `session.fromPath(...)` session, never `session.defaultSession` and never the same session as cloud authentication.
- Keep browser profile data under CodeInOven's config directory. Provide visible data size and one-click Clear browsing data / Delete profile actions.
- Do not duplicate cookies into `SecretVault`; Chromium's session store owns browser state. The application must not maintain a second cookie database.
- Browser profile identifiers are opaque random IDs. Profile display names and bookmarks may be stored through the atomic storage engine.
- Cookie access remains private to `BrowserWorkspaceService`. Do not expose a generic “get cookies” IPC method.
- On profile deletion, destroy every associated `webContents`, wait for session activity to close, clear session data, and then remove the profile directory through a recoverable/explicit workflow.

### Manual browsing versus agent control

The manual authenticated browser and an agent-controlled browser must be separate security products:

- **Manual profile:** persistent, human-controlled, may contain valuable authenticated sessions. Agents cannot inspect or operate it by default.
- **Agent profile:** ephemeral and thread-scoped by default, with no access to manual cookies. If persistent automation is added later, it needs a visible per-turn grant, domain scope, an activity indicator, an action audit trail, and immediate revoke/stop.
- Never solve agent automation by exposing Chrome DevTools Protocol or raw session cookies to arbitrary harnesses. If agent browser control is added, broker a narrow action API in main and bind grants to a thread and turn.
- Existing computer-use support should not implicitly acquire control of the main CodeInOven window merely because Browser is visible. That would make the agent capable of clicking app-level permission prompts or reading unrelated work. A controlled browser worker/window is safer for automation.

## Import policy

### Supported first

- Bookmark HTML import/export, with preview, deduplication, and explicit destination folder.
- Manual sign-in on sites in the CodeInOven browser profile.
- Optional CSV bookmark import only if a clear schema is defined. Do not import passwords from CSV.

### Do not ship as a baseline feature

- Copying an entire live browser profile directory.
- Reading browser cookie SQLite databases.
- Importing passwords, passkeys, payment data, extensions, history, autofill, or browser key material.
- Starting a user's regular browser with remote debugging enabled.

Raw profile copying is brittle because browser profile formats and Chromium versions are not backwards compatible; source databases may be locked; cookies and passwords are OS/browser encrypted; importing them expands platform permissions and turns CodeInOven into a credential-migration product. It also creates ambiguous ownership when the original browser and CodeInOven mutate the copied state independently.

If cookie migration remains a hard requirement after the browser workspace proves useful, treat it as a separate, opt-in project with one importer per supported browser/OS/version family, no background syncing, a pre-import risk disclosure, source-browser-closed checks, rollback, and security review. It should not gate the first release.

## Lifecycle and performance contract

### When unused

- Do not import or construct `BrowserWorkspaceService` at startup.
- Do not call `session.fromPath`, create a `WebContentsView`, register polling intervals, or warm browser data until the user opens Browser.
- Sidebar/navigation state may be plain Svelte data only. Persistent files on disk are acceptable; they consume no CPU/RAM.
- No background bookmark sync, favicon crawl, update loop, network request, or hidden renderer.

### When active

- Start with one live tab. Cap live tabs (recommended initial cap: 3); overflow tabs are serialized as URL/title and recreated on selection.
- Destroy closed tab `webContents` immediately. Do not merely hide them indefinitely.
- Stop page audio and present a visible indicator; default autoplay off for remote content. The indicator is implemented on the tab strip: a tab that is audible
  shows a speaker in place of its favicon, clicking it mutes that tab through
  `browser:setMuted`, and `BrowserPageState` carries `audible`/`muted` so the
  state is always main's answer rather than the renderer's assumption.
- A tab that holds a live microphone, camera or screen capture shows a recording
  indicator. Electron exposes no capture state for a `WebContentsView` and this
  design forbids a preload, so `browser/browser-service/browser-capture.ts`
  injects a track-counting `getUserMedia`/`getDisplayMedia` observer into each
  frame's own world over the same `executeJavaScript` boundary the labeled-dialog
  shim uses. The observer counts tracks only: it reads no stream, no media and no
  page data, and it gives page script no way to reach privileged APIs.
- Downloads are visible in the browser toolbar, not only in a menu: the button
  carries the count of unfinished downloads (running ones plus stopped ones
  waiting for a decision) and opens the list in normal layout flow.
  The page is a native view composited above the DOM, so the list takes layout
  space and resizes the view instead of floating over it, and each finished
  download can be revealed in the operating system's file manager.

### Downloads

One process-wide manager (`src/main/browser/browser-service/browser-downloads.ts`)
owns every download a browser tab starts, and it is deliberately not window-bound:
a window is parked to the menu bar and rebuilt on reopen, while a download
belongs to its project's session and keeps running. The manager holds the live
items, the durable records, and one `will-download` registration per project
session; a parked window costs progress events and nothing else.

Records persist to `browser/downloads.json` through the storage engine, with the
same merge-on-write shape the browser permission memory uses, so a download is
still on screen   with the action it can honour   in the next run:

| State | What it means | Actions |
| --- | --- | --- |
| `progressing` | A live Chromium download; `paused` when the user paused it | Pause/Resume, Cancel |
| `interrupted` | Stopped, with bytes on disk; `resumable` when they can continue it | Resume, Start over, Remove |
| `cancelled` | Stopped and discarded, as Chrome's own Cancel does | Start over, Remove |
| `completed` | The file is finished | Open, Reveal, Remove |

Two facts about Chromium's download stack shape the rest, both verified on
Electron 44 and kept honest by the code that reads them:

- A download's partial file is written at the path the save dialog chose, and
  Chromium deletes it when the download is cancelled or the process owning it
exits. Pausing does not save it. A quit therefore pauses each running download,
lets it settle, and *moves its bytes* beside the target (`.codeinoven-part`,
renamed rather than copied) before the records are written. Without that move a
quit leaves a record with nothing to resume from, which is what "the download
was gone after I closed the app" was.
- Resuming is Chromium's own resume (`session.createInterruptedDownload` plus
  `resume()`), which sends the range request with the validator the response
  already provided (`ETag`, else `Last-Modified`). The offset never exceeds what
  this app wrote, so a file that was longer before the download started cannot be
  mistaken for downloaded bytes, and a download whose total or validator
  Chromium never learned offers *Start over* instead of an unsafe resume.

A download whose bytes already add up to its declared total is settled as
completed: the last byte landed and only the completion event was lost.
- Use Chromium's natural site isolation. Track renderer crashes and unresponsive events without allowing them to crash or block the agent UI.
- Rate-limit browser-to-app metadata events (progress, title, favicon) so page churn cannot flood main/renderer IPC.
- Maintain a browser-specific memory budget and expose a small diagnostic snapshot: live tabs, webContents/process IDs, approximate memory, crash count, and profile disk size.

Important current constraint: the main application sets `backgroundThrottling: false` (`src/main/index.ts:701-708`). Electron documents that disabling throttling on one `webContents` affects other `webContents` in the same host window. Therefore inactive browser tabs must be destroyed/frozen explicitly, or the browser must use a separately hosted window/view architecture. Do not assume hidden `WebContentsView`s will become cheap automatically.

Suggested acceptance budgets, to be confirmed on target hardware:

| State                        | Runtime target                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Never opened this launch     | No browser session/view/process created; no browser timers or network                                         |
| Browser closed               | No browser renderer process; only persisted profile data and lightweight navigation state remain              |
| One simple page active       | No measurable agent stream/terminal latency regression; app main-process event-loop p95 regression under 5 ms |
| Dashboard stress page active | Agent output remains interactive; browser can be stopped independently within 1 second                        |
| Browser renderer crash/hang  | Agent runs and terminal stay alive; browser surface offers reload/recreate                                    |

Memory cannot have a universal fixed ceiling because websites control their own workload. Measure and publish representative baselines rather than promising zero impact.

## UI shape

Browser should be an optional top-level workspace reachable from the primary sidebar/header, lazy-loaded like other major surfaces. It should not replace the project sidebar or embed permanent controls into every thread.

Minimum browser chrome:

- back, forward, reload/stop;
- address/search field with clear origin/security display;
- bookmark current page and bookmark drawer;
- profile/data controls;
- permission/download prompt area;
- close browser workspace (“Stop browser”) that clearly releases runtime resources.

When Browser is active, agent work continues in the background and its status remains visible through existing global indicators. Switching back must be instant and must not rehydrate the agent workspace.

## Delivery plan

### Phase 0: Spike and measurement (2-4 engineering days)

- Create a disposable `WebContentsView` from main with a temporary, in-memory session.
- Prove bounds synchronization, focus/keyboard behavior, navigation, popup interception, permission denial, crash isolation, and teardown.
- Measure agent streaming and terminal responsiveness while loading a representative heavy deployment dashboard.
- Decide whether the same-window host is acceptable given the existing background-throttling setting.

Exit gate: closing the spike leaves no browser renderer process; an unresponsive/crashed page does not affect a running agent turn.

### Phase 1: Secure manual browser MVP (1-2 engineering weeks)

- Main-process `BrowserWorkspaceService`, typed IPC, main view/navigation entry, one persistent profile, one live tab.
- HTTPS navigation, origin display, popup policy, permission default-deny, production DevTools policy, crash/reload UX, clean disposal.
- Manual sign-in and bookmark HTML import/export.
- Clear browsing data, delete profile, and storage-size visibility.
- Focused tests for URL validation, sender validation, lifecycle idempotency, partition separation, permissions, popup policy, and teardown.

Exit gate: external security review of the remote-content boundary and packaged-app smoke tests on macOS, Windows, and Linux.

### Phase 2: Usability and bounded tabs (about 1 engineering week)

- Small capped tab model, sleeping/serialized inactive tabs, download manager (delivered; see “Downloads”), per-origin permission settings, session restore, keyboard shortcuts, accessibility.
- Performance telemetry kept local and privacy-redacted.

Exit gate: documented resource budgets hold during simultaneous terminal output, one agent stream, and representative dashboards.

### Phase 3: Optional agent browser (separate project)

- Ephemeral thread-scoped profiles, explicit grants, domain boundaries, audit events, stop/revoke, and human-visible control state.
- Do not reuse the manual authenticated profile by default.

## Principal risks and mitigations

| Risk                                             | Consequence                                      | Required mitigation                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Remote site compromises guest renderer           | Attempted jump into desktop privileges           | Sandboxed `WebContentsView`, no preload/Node/IPC, current Electron, strict navigation/window policy                            |
| Cookies become accessible to agents/app UI       | Account takeover                                 | Separate manual profile; no cookie IPC/export/logging; explicit future grants only                                             |
| Profile import breaks or corrupts data           | Lockout/data loss and ongoing compatibility debt | No raw profile copy; bookmark standards + manual sign-in                                                                       |
| Heavy dashboards degrade agent work              | Poor core experience                             | On-demand construction, live-tab cap, explicit stop/destroy, stress budgets and diagnostics                                    |
| OAuth/passkey/site incompatibility               | Users cannot sign in everywhere                  | Compatibility matrix, OS-browser fallback, never weaken sandbox to “fix” a site                                                |
| Popups/downloads/permissions escape policy       | Unexpected files/devices/windows                 | Main-owned prompt and allowlist policies, default deny                                                                         |
| Browser feature expands into a full Chrome clone | Permanent product/maintenance drag               | Keep scope to authenticated dashboard access; no extension ecosystem, password manager, sync engine, or general browser parity |

## Go/no-go recommendation

**Go** for the Phase 0 spike and a narrow manual-browser MVP. **No-go** for raw cookie/profile copying and for sharing the user's authenticated manual session with agents.

The feature avoids technical debt if the product promise remains: “a secure, disposable-in-memory browser surface with a dedicated persistent login profile for managing web dashboards.” It becomes technical debt if the promise becomes: “import and behave exactly like the user's existing browser” or “let every agent inherit the user's browser identity.”

## Primary references

- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron `WebContentsView`](https://www.electronjs.org/docs/latest/api/web-contents-view)
- [Electron session partitions](https://www.electronjs.org/docs/latest/api/session)
- [Electron cookies API](https://www.electronjs.org/docs/latest/api/cookies)
- [Electron `<webview>` warning](https://www.electronjs.org/docs/latest/api/webview-tag)
- [Chromium profile compatibility warning](https://www.chromium.org/administrators/policy-list-3/user-data-directory-variables/)
