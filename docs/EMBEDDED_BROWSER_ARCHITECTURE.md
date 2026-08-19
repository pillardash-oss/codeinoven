# Embedded Browser Architecture Assessment

## Decision

Build an optional, manually operated browser workspace, but do **not** copy or mount a user's live Chrome, Edge, Firefox, or Safari profile.

The maintainable design is a main-process-owned `WebContentsView` using a dedicated persistent Electron session. The view is created only when the user opens Browser, is destroyed when the browser workspace is closed, and has no preload or access to CodeInOven IPC. Users sign in normally inside that isolated profile. Bookmarks may be imported from standard bookmark exports; raw cookie, password, and whole-profile import are deliberately out of scope for the first release.

This is feasible without weakening the agent workspace, but “zero resource use while browsing” is not possible: a real dashboard executes JavaScript and consumes memory, CPU, GPU, network, and disk. The enforceable target is zero browser renderer/runtime cost while the feature is unused, bounded and observable cost while active, and prompt teardown when closed.

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
- Install permission request and permission check handlers on the browser session. Default deny; prompt for the exact origin and permission; support Allow once, Always allow for this site, and Deny. Start with camera, microphone, geolocation, notifications, HID, serial, USB, MIDI, screen capture, and filesystem access denied.
- Prevent silent downloads. A later download phase may use a native save dialog, safe filename normalization, progress UI, cancel, and an explicit “open” action. Downloads must never land in the active repository automatically.
- Redact browser URLs/query strings from general logs and diagnostics. Sensitive page titles should not enter agent context or telemetry.

### Session and profile storage

- Use a dedicated persistent `session.fromPath(...)` session, never `session.defaultSession` and never the same session as cloud authentication or remote mode.
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
- Stop page audio and present a visible indicator; default autoplay off for remote content.
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

### Phase 0 — Spike and measurement (2-4 engineering days)

- Create a disposable `WebContentsView` from main with a temporary, in-memory session.
- Prove bounds synchronization, focus/keyboard behavior, navigation, popup interception, permission denial, crash isolation, and teardown.
- Measure agent streaming and terminal responsiveness while loading a representative heavy deployment dashboard.
- Decide whether the same-window host is acceptable given the existing background-throttling setting.

Exit gate: closing the spike leaves no browser renderer process; an unresponsive/crashed page does not affect a running agent turn.

### Phase 1 — Secure manual browser MVP (1-2 engineering weeks)

- Main-process `BrowserWorkspaceService`, typed IPC, main view/navigation entry, one persistent profile, one live tab.
- HTTPS navigation, origin display, popup policy, permission default-deny, production DevTools policy, crash/reload UX, clean disposal.
- Manual sign-in and bookmark HTML import/export.
- Clear browsing data, delete profile, and storage-size visibility.
- Focused tests for URL validation, sender validation, lifecycle idempotency, partition separation, permissions, popup policy, and teardown.

Exit gate: external security review of the remote-content boundary and packaged-app smoke tests on macOS, Windows, and Linux.

### Phase 2 — Usability and bounded tabs (about 1 engineering week)

- Small capped tab model, sleeping/serialized inactive tabs, download manager, per-origin permission settings, session restore, keyboard shortcuts, accessibility.
- Performance telemetry kept local and privacy-redacted.

Exit gate: documented resource budgets hold during simultaneous terminal output, one agent stream, and representative dashboards.

### Phase 3 — Optional agent browser (separate project)

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
