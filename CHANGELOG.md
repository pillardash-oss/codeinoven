# Changelog

All notable changes to CodeInOven are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **Every comment you write can be asked about first.** The studio selection
  popover already offered Explain and Quick Chat on its feedback comment; that
  pair now sits on every comment field in the app, in one shared component: an
  element picked inside an online HTML or SVG artifact, a mark drawn on a
  published picture or video frame, a moment noted in the video editor, an
  element picked by the design inspector, and a passage annotated in a project
  document. Both open the existing read-only side chat with the annotation's own
  descriptor as the selection, so nothing is re-derived from pixels, and each
  surface adds only the bounded framing that makes that descriptor readable: the
  artifact source, the design folder and screen, the composition folder, or the
  document.

- **A film ships with the app to start from.** The video capability gains a
  `scaffold` operation that copies a finished film into a project folder and
  installs the composition runtime beside it, so the first frame of the work is a
  composition that already plays and already exports. This build ships
  `product-launch`: fifteen seconds at 1920x1080 in four beats, with its own type
  under the SIL Open Font License, a synthesized bed, and a README carrying the
  beat map and the exact list of what to replace. The copy refuses a folder that
  already holds a composition instead of merging into it.

- **Motion craft reaches the video capability's own guidance.** A film now starts
  from one representative frame and a premise rather than from particles, carries
  one motif through every beat, and picks its curve on purpose: `CIOVideo.easings`
  exposes ten named curves where the runtime offered a single cubic out, which is
  the one every composition used to hand-roll for itself. `composition.json` also
  takes an optional `audioPolicy` of `required` or `silent`, and the video guidance
  treats sound as a decision: a film meant to be heard produces real local audio,
  aligns accents to measured audio rather than a guessed pulse, and never reports
  silence as a finished film.

- **An export is checked before it is called delivered.** The export job now
  verifies what it produced: the file exists where the export says, carries a video
  stream at the manifest's frame size, runs the manifest's length, decodes to the
  end, and holds the sound the composition declares. A render that fails is kept as
  `render.failed.mp4` and the job reports the real reason instead of a file list, so
  a broken export cannot be mistaken for a finished one while the composition source
  stays untouched. A completed job carries what was measured.

- **An assistant run running in another instance is transferable in place.** An
  assistant task and its runs are different threads, so opening the task showed
  nothing when one of its runs streamed in a sibling CodeInOven window, because
  the ownership notice belongs to the run thread. The task and run rows now wear
  the still **running in another instance** window mark instead of a spinner and
  carry a transfer action, opening the task shows its foreign run's transfer
  card above the composer while the task stays usable, and a run thread opened
  directly shows the card it always did.

- **OpenCode is one harness, driven at whichever version is installed.**
  OpenCode V1 and V2 both install as the `opencode` command (the vendor's V2
  installer replaces a package-managed V1 binary, and a package-managed V2
  install may add an `opencode2` alias). The app probes `opencode` and
  `opencode2`, keeps the newest version, and drives the transport that matches
  it, so a V2 machine streams over the V2 `/api/*` HTTP+SSE surface and a V1
  machine keeps the V1 server API. There is no second harness entry and no
  version picker: the Harnesses page shows one **OpenCode** row with its
  detected version, and its install/update/uninstall channels now target the
  current release.

  The V2 transport is fully drivable: threads stream text and reasoning, run
  tools, ask interactive questions through V2's form surface, answer or dismiss
  them, accept mid-turn steering, mirror their native transcript, compact on
  demand, run slash commands, and stop on interrupt. Model, agent, and
  thinking-level selection are applied per turn (V2 scopes them to the session),
  attachments are supported, and the model picker reads the server's own
  catalog. Thread titles, turn grading, cheap-model one-shots, heartbeats, and
  every disposable flow (temporary chats, transcription, image description,
  brainstorm/spec/assignment offshoots) run on private V2 servers that are torn
  down when they end, and a delegated sub-agent is surfaced as a child-agent
  card (V2 announces the child session with a non-null `parentID`).
  `opencode auth list/login/logout` backs the provider account UI at both
  version lines, and a V2 integration that holds several keys reports each
  connection as its own account. CodeInOven's account containers still isolate
  V2 completely: the container environment relocates V2's config and its SQLite
  store, so each account keeps its own credentials and state.

  Custom base-URL providers are claimed for the single entry. V2 cannot restrict
  `read` in a session permission ruleset (its own provider entitlement is
  evaluated through the same ruleset), so a restricted V2 turn denies everything
  that mutates instead of every tool. Token and cost usage is read from the V2
  session stats and message payloads, and the account's Go quota windows are read
  from OpenCode's own usage API (`https://opencode.ai/zen/go/v1/usage`) for
  whichever line is installed: V1 from its `auth.json`, V2 from its SQLite
  credential store. The local **OpenUsage** integration remains the fallback that
  answers the same question for any provider, so account quota is a local
  capability. Only the hosted Console workspace budgets and CSV export stay a
  separate service-account product. Structured output is not claimed for either
  line (V2 has no JSON-schema mode, and V1 deliberately keeps deterministic JSON
  flows off its history endpoint).

- An end-to-end suite for the OpenCode harness is committed and gated on
  `OPENCODE_E2E_BINARY`: with a real install it proves the app selects the
  transport matching the detected line, that the V2 catalog is read over the
  HTTP API (waiting out the server's first-boot window), and that a real turn
  streams and mirrors its history. It reports as skipped wherever no OpenCode
  binary is present, so CI stays green.

- **OpenCode's own multi-account and provider hiding are first-class again.**
  The harness manifest now declares a `multipleAccounts` behavior, and the auth
  capabilities are derived from that declaration instead of a hardcoded default:
  OpenCode reports native multi-account support, and account activation is
  enabled only when the installed line actually has a switch command
  (`opencode auth switch <integration> <credential>`, V2 only; V1's `auth` has
  only `list`, `login`, and `logout`). Selecting an account that lives in
  OpenCode's own default store makes it the active credential, so a turn uses
  the account the user picked rather than whichever one OpenCode last had
  active. Accounts the user creates inside OpenCode itself are read by
  `opencode auth list`, one row per stored connection, and stay separately
  actionable on the connect screen: a provider with two keys gets two rows with
  their own disconnect, matched by the credential id each row mirrors. Because
  that list never reports which connection is active, the flag is read from
  OpenCode's store and the account list's default badge follows it, so the app
  shows the account a turn will really use even after a switch made inside
  OpenCode.

- Provider hiding works at both OpenCode lines again, with the toggle restored on
  the provider connect screen (it was dropped when the account and model pickers
  were unified). V1 keeps writing `disabled_providers`. V2 writes the documented
  replacement from [the V2 policies guide](https://opencode.ai/v2/docs/policies/),
  an `experimental.policies` statement
  `{action:'provider.use', resource:<id>, effect:'deny'}`, which removes the
  provider from the catalog and from model selection even with valid
  credentials; denies are appended last, where the last matching statement wins.
  A V2 read is the union of that list and `disabled_providers`, because a V2
  install still translates a V1 list it finds, and a V2 write mirrors the same
  set back into `disabled_providers` so the user's hiding survives a switch to a
  V1 install. Unrelated policy statements and the rest of the config file
  round-trip untouched, and the cached provider catalog is invalidated so the
  model picker updates immediately.

- The agent can now collect secrets without ever seeing them. A new
  `cio_ask_secret` **gateway** tool (the utility gateway every harness already
  reaches, not a per-harness tool) asks for one or more values by title and
  description; the app renders a password card with an in-field reveal toggle and
  a "Secrets are not sent to the agent" note and stores each value in the
  encrypted vault. A value bound to a capability by `utility_id` is stored
  exactly as the Utilities page stores it, so an MCP that needs a key can be
  finished in one turn. A plain value is re-exposed to the thread each turn as an
  OS environment variable (`CIO_<ID>_<TITLE_SLUG>`, or the exact name the target
  expects) and as an owner-only `0600` file the agent interpolates with
  `"$(cat secret_path)"`, so CLI work needs no plaintext in chat. Neither the
  tool result nor any MCP transport ever carries the value: the model receives
  only `Secret set, you may proceed.` and the names.

- The secret card now offers **Provide alternative**, the same escape hatch the
  permission card has. A user who cannot reach a value they already supplied
  answers with an instruction instead of pasting, and the app resolves every
  requested name from state the device already holds this thread's registry, a
  credential bound to an installed utility, or another thread's registry adopts
  it for the current thread and exposes it exactly like a pasted value (session
  environment and owner-only file, or the utility credential). The user may name
  the stored variable when it was saved under a different spelling. Names with
  nothing stored behind them are reported back as `unresolved_environment_variables`
  together with the instruction, so the agent adapts instead of asking for the
  same key twice.

- The secret card now offers **Explain** and **Quick chat** at the bottom left of
  its footer, matching the question card. Both open the temporary read-only side
  chat with the request attached as its selection, and opening either pauses the
  card's countdown so it cannot expire while the user reads. The explain chat is
  told what the request is for and that an actual value must never be invented or
  guessed.

- **Sign in to GitHub without leaving CodeInOven.** The device-flow sign-in is a
  dockable panel now instead of a modal, so it can get out of the way while the
  user authorizes and keep polling from wherever they are, and it offers both
  destinations explicitly: the operating system's browser, or the app-wide
  CodeInOven browser. Signing in inside the app docks the sign-in **into that
  browser's own view**: a browser page is a native view painted above every DOM
  node, so the panel cannot float over the page it opened, and it is a row of the
  browser's page column instead, which the page shrinks around the way it already
  does for the find bar. The code, the countdown it expires on and the attempt's
  status stay in that row for the whole wait, with a copy control and a chevron
  that opens the full details and both destinations in place, so nothing about a
  sign-in in progress is more than one click away from the page it belongs to.
  Every other view still floats the panel, and it is the same flow either way.
  The Git panel's account menu reloads the moment the authorization lands. A
  sign-in the user no longer wants is explicitly cancellable: **Cancel** sits at
  the footer's left edge while an attempt is in flight, the docked row and the
  dock chip carry the same dismiss control, and it cancels the attempt rather
  than merely hiding it, since the header withholds its close affordance until
  the flow settles. The in-app hand-off is awaited and confirmed before the panel
  docks, so a first-open in a session (which reads the browser's modules and its
  durable tab list first) shows an **Opening…** state instead of a click that
  silently did nothing, and a browser that does not take the page within eight
  seconds hands it to the operating system's browser instead, with the code
  already on the clipboard and the reason stated in a toast.

- **A harness switch keeps both branches, so switching back is warm.** A switch
  used to mint a cold session on the target harness and delete the source
  session, its native transcript and its provider prompt cache, so both
  directions of every switch paid a full replay. The source session is now
  parked instead: its record and native transcript stay on disk (one branch per
  harness and thread, freshly replaced ones pruned), its live process is
  stopped so nothing lingers in the background, and the next switch back adopts
  that session and resumes it. Only the turns produced while the thread was on
  the other harness are replayed, as a small delta instead of the whole
  transcript, which keeps the parked prefix a cache read. pi replays that delta
  on every turn because its history recap rides a context hook for one turn and
  never reaches its transcript; drivers that fold the recap into the turn's own
  prompt text already persist it and replay it once.

- **An agent runs a checker once over a list of files, not once per file.** A
  thread that validated 430 changed components made 2,283 separate `svelte-autofixer`
  calls, one per file, each its own model round trip. The behavior contract now
  states that the same inspect-only operation over many inputs belongs in one
  code-mode script that loops with bounded concurrency, and the utility
  instructions say the gateway's own batch operation covers the app's read-only
  tools only, so a server-side utility or MCP operation is scripted rather than
  batched.

### Changed

- **The task card says what the agent is on, not only how far the list has come.**
  Its head read `Tasks`, a position (`2/3`), and the state (`Running`), so a folded card
  told you progress and never the work: the one thing the list exists to answer still
  took opening it. The head now names the task at that position, truncated between the
  position and the state with the whole label on hover, so a folded card says what the
  agent is doing right now. The label is derived from the same active index the counter
  counts (`activeAgentTodoIndex`), so it appears only while a run is live: a stopped card
  keeps its completed count and names no task, because nothing is being worked on.
  Verified on an isolated probe with a live card and a stopped one.

- **A new assistant introduces itself, and the Getting started thread stops
  looking like a place to give it work.** An assistant created from the form used
  to sit silent until the user spoke first, and the interview then asked for the
  name and the personality the user had just typed. It now opens the conversation
  itself, told its own name and personality: it greets the user in those words,
  asks the one thing it needs to talk to them (what they want to be called, asked
  through the question card and nothing else about them), says it is ready, and
  says plainly that this thread is where they teach it and reshape it. A task goes
  to a new one, and the copy names the app's own affordance for that (the New task
  button in the header, or its shortcut) instead of inviting a message here. The
  post-setup next-steps message follows the same rule and leads with the call to
  action that fits how the assistant runs: fallback models for one on a clock,
  starting a task for one that runs when asked. The interview no longer asks again
  for a name and personality that are already settled, and the assistant's own
  empty state on that thread points at a new task rather than at sending a
  message.

- **A thread keeps a marker for every kind of work it has authored.** A row drew
  only the thread's current design or video session, so a thread that designed
  something and later cut a video about it lost its design mark. Threads now
  carry the durable set of authored-work kinds beside the current session, and
  the row draws one marker per kind in a stable canonical order.

- **Agents answer like they are briefing an executive, and diagrams stop being
  decoration.** Long, meandering replies were normal, because nothing told an
  agent how much prose to write, and the Mermaid instruction only asked for a
  diagram "when materially clearer", so answers arrived with illustrations of
  what the surrounding text already said. Day-to-day implementation and chat
  turns (including chats inside the browser) now carry an app-owned reply budget:
  lead with the outcome, fit the whole answer into at most two short paragraphs,
  no preamble, no restating the request, no closing summary, and no narration of
  the agent's own process. A reported problem is exactly three things (what
  happened, what caused it, what changed), long-form detail belongs in a document
  the reply points at, and the agent expands only when the user asks for the full
  explanation. The engineering lifecycle keeps its full technical output: a
  specification, PRD or Assignment turn never loses detail to the budget, and a
  saved assistant keeps its own, stricter message-length contract. The diagram
  rule is now exception-first: a diagram only when the flow or relationship is
  genuinely hard to follow in text, or when the user asks for one, at most one
  per reply, never decorative. Both rules are app-owned and injected by the turn
  composers, so no customized prompt can drop them, and the shared diagram
  wording also replaces the older sentence in the editable prompt defaults in
  Settings.

- **Looking into an issue no longer needs a tag.** Read-only app diagnostics
  (`cio_util_diagnose`: thread lookup by id or title, mirrored conversation
  pages, log tails, the SQLite schema, and read-only SELECTs) was granted only on
  a turn that carried the explicit `@cio-utility` tag, so an agent asked to look
  into "this thread failed" or "what does the log say" could not reach any
  evidence until the user re-sent the same message with the tag. It is now an app
  capability granted on every turn that carries the utility gateway, and the Pi
  extension advertises it, so an ordinary turn knows it can look a reported
  problem up itself. The capability is otherwise unchanged: read-only, redacted,
  bounded, and it never writes, deletes, or reconfigures anything. Installing a
  utility is still a state change and still needs the explicit setup grant.

- **The main instance is now an explicit, remembered choice.** Picking **Make this the main
  instance** in a secondary window used to be honored only while that exact process lived:
  once it restarted, ownership fell back to the longest-running live process, so a leftover
  or development launch could take the schedule without the user asking. The transfer now
  records the chosen app's stable identity (its executable path) alongside the pid, so a
  later launch of that same app reclaims the schedule across restarts. While the chosen app
  is not running the election still applies, so scheduled work is never stranded, and the
  designated app takes the schedule back when it returns.

- **A waiting update is now something you can act on.** The rail's update control used to
  go dead the moment a downloaded update hit the install gate, showing "Update waiting for
  N active threads to finish" with no way to respond, so a thread the app still believed
  was working could hold an update off indefinitely. Clicking it now opens a confirmation
  that names what is actually in the way — the working threads grouped by project, and any
  live terminals — in the same shape the close-while-working prompt uses, with a
  **Stop work & install** action that stops all of it and installs. The Settings update
  panel offers the same **Review…** entry point. The gate's patience is unchanged: nothing
  is stopped and no timeout applies unless the user asks, and the status behind it is only
  ever settled by the thread's own harness reporting itself idle, never by a timer.

- A capability installed without explicit harness targeting now applies to every harness,
  present and future. A missing `harnessBindings` used to normalize to an empty list, which
  `resolve` reads as "no harness", so the setup contract had to make the agent enumerate
  harnesses. It now stores a single `{"harnessId":"*"}` binding and the contract treats the
  field as optional, so a global install reaches every harness and a harness added later
  resolves it with no reinstall.

- Replaced the 1–5 per-turn feedback ledger with a 0–10 conversation-grading
  model-ranking system. Rankings are keyed by harness + provider + model +
  thinking level and split into separate **one-shot** and **multi-shot**
  scores, sample counts, and agent runtime per configuration. Greeting-only
  first prompts are never graded. Existing graded history folds into the new
  aggregate under the `legacy-1to5-map-v1` rubric tag (linearly mapped, only
  approximately comparable to the new rubric; the Profile settings surface
  shows the rubric version per row). The Profile analytics section
  "Best model by feedback" becomes "Model rankings" with one-shot/multi-shot
  columns, and the old blended grade-of-five display is gone.

- Automatic memory proposals now weigh the user's wording before remembering
  anything. The deciding model reviews the turn as an explicit two-step
  evaluation (lasting rule versus one-off request) and receives the user's
  earlier message as supporting context. Requests the user repeated in the
  current task, including ones accompanied by "I have told you before" or
  "why do you always" out of frustration, and the frustration itself, are no
  longer proposed for memory.

- **The highlight toolbar is a real context menu, and a right-click opens the
  same one.** Selecting a passage in an assistant response, an annotated
  document or a studio document used to raise a single horizontal strip of
  actions; the same actions now open as a top-to-bottom menu, once on the
  highlight and once at the cursor on a right-click, with `Copy` as the last
  item so the plain copy that used to live in the app's text menu is still one
  click away. It opens beside the point the selection stopped at, so a passage
  that runs down two lines raises it at the end of the drag rather than at the
  top-left corner of the quote, and a selection made right to left raises it at
  the left end it stopped on. A right-click that lands on a passage already
  carrying a comment also reopens that comment's bubble, and its first item
  edits that comment instead of attaching a second one to the same words. Links
  and external address controls keep their own menu, and fields keep cut, paste
  and select all.

### Fixed

- **The packaged startup gate ends when it is done, and a dismissed close no
  longer quits the app.** The gate proves a packaged boot by launching the real
  window and reading the startup proof the app writes, then letting the app quit
  itself; it now ends the process itself once disposal has finished, because
  Electron's teardown after `will-quit` can stall on an ad-hoc signed bundle
  (which is what the local macOS gate packages) and no JavaScript runs after
  `will-quit`, so the run waited out its timeout instead of reporting the pass it
  had already proven. Separately, the quit watchdog armed while the close
  confirmation is open was never cancelled when the user dismissed it (or when a
  save it asked for failed), so the app force-exited fifteen seconds after they
  chose to keep working; the renderer now reports the abandoned close and the
  watchdog is disarmed.

- **A selection in the agent's instruction modal can be copied again.** That modal exists to
  be copied from, yet right-clicking a highlighted line gave no menu and nothing reached the
  clipboard. The dialog was drawn the way every blocking dialog is drawn: projected into the
  browser overlay window, which is a separate document whose projected text _is_ selectable but
  where nothing owns a right-click. The shared text menu
  (`components/shared/TextSelectionContextMenu.svelte`) lives in the app window, so it never saw
  the event. The instruction modal now stays in the app window (`nativePresentation={false}` on
  its `ui/Modal.svelte` call), which is the shell's existing presentation whenever a projection
  cannot be used, so its text answers a right-click with Copy and Select All exactly like the
  rest of the app's text, while "Copy instruction" still copies the whole block. Verified on an
  isolated probe against both revisions: before the change the app-window panel sat inside an
  `inert` ancestor, `elementFromPoint` over the instruction returned `html`, and the selection
  was dropped at once; after it the hit test lands on the `pre`, the selection survives the
  right-click, and the menu opens above the panel. Every other blocking dialog is still
  projected into the overlay window, so text in those still has no right-click menu; that is the
  same gap one layer up, in the overlay document rather than in a dialog.

- **A comment written in a temporary chat now exists.** Selecting a passage
  inside a side chat dropped the text into the composer and nothing else: the
  comment editor never opened, because a side chat keeps its own references on
  its tab instead of in the thread store the editor read. A side chat now keeps
  the passage, the comment written on it and the range it was taken from
  together, so the highlight is drawn, the comment editor opens on the passage,
  the composer chip edits and removes it, and the comment travels to the harness
  in the turn's `<selection>` block beside the quoted text.

- **A selection keeps up with shift and the arrow keys.** Highlighting a passage
  and then extending or trimming it with shift and an arrow key left the action
  menu, the comment popover and the quote they carry on the text the pointer had
  first selected. All three now follow the live selection: the menu moves and
  renames itself with the highlighted text, and the studio and document
  annotation popovers re-read their quote, offsets and position on every step,
  so the comment is anchored to what is highlighted when it is submitted.

- **The design and video board never renders blank again.** The panel showed a
  design or a video composition, and at times its body came up empty and stayed
  empty until a reload. Its props came from `{...coordinator.panel.props}`, where
  the registration belongs to the thread on screen: that is null for the length of
  a thread switch, while another top-level view is up, or the moment a session
  stops coordinating. Svelte reads a child's props through getters that re-read
  their source for as long as the child is mounted, including the frame it
  unmounts on, so the board threw `Cannot read properties of null (reading
'panel')` on the way out; the throw unwound through the rail's keyed swap, the
  fallback empty state never painted, and the board's job poll kept running (the
  app's own log shows it erroring every 1.5 seconds for over a minute). The
  composition pane's stage read `tab.tabId` the same way, which is the second
  throw in that log. The panel now belongs to the active tab's own coordinator
  row and reads its props through the last answer that was not null, while the
  live value still decides whether a board is shown at all; the stage keeps the
  tab it was built for as the floor of every read. Measured on an isolated probe
  against both revisions: the old code raised the throws and left the body empty
  (re-publishing the row could not bring the board back), the fixed code raises
  neither, restores the board when the row comes back, keeps it while the thread
  selection is gone, and unmounts the stage cleanly.

- **An assistant stops tagging its message with its own urgency.** The run
  contract told the assistant to "label the report with the bracket it actually
  falls in", with the bracket ids listed right there, so a run prefixed its
  update with something like `[whenever · just-me]`. Nothing in the app reads that
  text, so it was pure noise the user never asked for. Urgency is now stated as
  the run's own guidance for how hard to push and whether to interrupt, and the
  contract says plainly that it never appears in the message. Result extraction
  also drops such a leading tag if an older or over-eager model still writes one,
  while a sentence that merely starts with the same kind of word ("Today both
  sites are online.") is left alone.

- **An assistant's update is delivered even when it runs long.** Result
  extraction treated the 80-word brief limit as a gate: a run that wrapped its
  answer in `<assistant_result>` and wrote past the limit had the whole message
  thrown away and replaced with "I could not produce a clean update. Please retry
  this run.", so a slightly long answer cost the user the answer itself. The
  brief limit is guidance again: a longer result is shown as written, and the
  retry message is reserved for a result that truly could not be read, like an
  empty or half-formed boundary.

- **A thread parked on a dropped connection resumes itself when the device is
  back.** Losing Wi-Fi does not only fail a request, it takes the harness process
  down with it, and the failure that comes back is not shaped like a transport
  error: a killed process reports an exit, an empty stream, or a driver-specific
  string, so it was read as a terminal verdict and the thread sat on an error
  card with nothing left listening for the reconnection the card promised.
  Connectivity is now tracked in one main-process service, and every
  announcement (the renderer's online and offline events, a wake from sleep, a
  request the app just watched fail) is a signal rather than a verdict: a real
  round trip, an uncached DNS answer and then one TLS request, has to succeed
  before the device counts as online, and one bounded timer re-probes with a
  backoff while the device is offline so a reconnection the operating system
  never announced is still found. On the transition back, a failure that carried
  no provider verdict but landed inside the connection-loss window is re-read as
  the connection wait it is, and every parked thread resumes through the retry
  scheduler in batches of two, so a mass reconnection never stampedes the
  machine. A provider that stated its own verdict (sign-in, billing, a usage
  window) keeps it, because those need the user, not the network. The behavior
  is harness independent.

- **A resumed thread continues the harness conversation it already had.** A pi
  account that keeps its own container runs pi with `PI_CODING_AGENT_DIR` pointing
  at that container, but the app resolved pi's session directory from its own
  process environment, which never carries the variable. The driver looked for the
  thread's transcript under `~/.pi/agent`, found nothing, and silently booted a
  brand new pi session on every resume, so a thread picked up after an idle gap
  answered from a replayed transcript instead of from its own conversation, with
  tool results reduced to summaries and no session to continue. The account's agent
  directory now travels with every transcript lookup (resume, transfer, seeding,
  sub-agent reads and compaction reconciliation), and the replay decision asks the
  driver whether the harness really holds the session rather than inferring it from
  a message count a driver's own durable mirror can satisfy.

- **Only one transfer of a thread can be in flight.** Two windows could ask an
  owning instance to hand a run over at the same moment, and both requests passed
  the owner's "is this still my turn" check before either stopped anything: both
  were accepted and both asked their window to adopt, which put two harness
  writers on one session and interleaved their output. Moving a run between
  instances now takes a per-thread mutex, a lease row in the shared config-root
  database. The receiving side holds the `adopt` claim for the whole hand-off and
  hands its token to the owner; the owner holds the `release` claim while it stops
  and settles, and refuses to act for any request whose claim it does not actually
  hold. A second claimant is refused before a run is stopped, a claim outlives its
  holder only briefly (its process dying or its lease running out frees the
  thread), and a legacy request without a token is still served under the release
  claim alone.

- An update can no longer hang on ghost active threads. The install gate read the
  chat engine's `working` status, which is recorded when a turn is dispatched and
  never revised unless the harness reports the turn's end, so a turn the harness
  could not run stayed "working" for the life of the process and the app waited on
  it forever. After an update that is exactly what happens: the launch resumes the
  interrupted threads before the deferred install asks anything, and a session
  whose harness changed under it never comes back. The gate now asks the harness
  what it is actually running before it decides, settles the sessions nothing is
  running through the normal turn-end path (status, thread, checkpoint and
  notifications all settle together), and needs that answer twice in a row so a
  compaction or retry gap is never mistaken for a finished thread. A live terminal
  now also blocks the install again: the engine's narrower working count used to
  replace the terminal count instead of adding to it.

- Automatic memory proposals no longer treat feature requests as durable
  preferences. The deterministic gate stops recognising request phrasing
  (`i want you to`, `make sure to`) and task imperatives as standing vocabulary,
  and it refuses a request that states no rule of its own. The decision the
  model makes now has to clear a floor on its primary "lasting intent" answer,
  so a first-time request can no longer pass on the strength of merely not being
  a repeat, and the decision prompt names feature requests and acceptance
  criteria as current-task work.
- The vision-model error card is dismissable in every state. A request that the
  engine already settled (its five-minute decision timeout, a newer descriptor
  request superseding it, or its harness session being retired) used to answer
  a dismiss click with `Image descriptor request is no longer pending`, leaving
  the card on screen; those paths now broadcast their resolution so the card
  closes, and a reply for a settled request settles the card instead of
  failing. Dismissing a question or secret card follows the same rule, and a
  `false_positive` report still records the model even when it arrives late.
- Image-descriptor requests now supersede each other: when a model issues
  several descriptor calls in one turn, the newest request dismisses the older
  cards and only the newest one waits for an answer, instead of leaving
  unanswerable cards behind that each timed out separately.
- A model that can already see images no longer receives the image descriptor.
  The utility gateway now withholds it for any model the provider catalog marks
  as image-capable, not only for models the user reported, and re-checks that
  capability on every gateway call so a `false_positive` report takes effect
  for the rest of the turn. A vision record also matches the model name segment
  of an id, so one report covers the same model behind other provider prefixes
  (`z-ai/glm-5.3-flash` and `ali/deepseek-v4.1-flash`).
- ⌘/Ctrl+Enter in the **New pull request** panel now docks the panel while the
  commit → push → create sequence runs, and the docked chip names the step in
  progress instead of only spinning. A dismiss button can no longer be
  taken as a modal's primary action, which previously closed the panel (mid
  creation) when the real primary action was disabled.

## [0.5.1] - 2026-08-06

### Changed

- macOS builds target **Apple Silicon (arm64) only**; Intel (x64) support is
  dropped. Windows (x64) and Linux (x64) remain unchanged.

## [0.5.0] - 2026-08-06

### Added

- Streamed Mermaid diagram rendering with strict-mode sanitization.
- Command-menu navigation preservation, inline-block arrow-key handling, and
  subagent recovery lifecycle fixes.
- Header project-info dropdown, full thread ID in the debugger sidebar, and
  Mermaid render fixes.
- Open source release-readiness: security policy, code of conduct, issue/PR
  templates, dependency automation, environment branches (`dev`/`nightly`),
  and a nightly prerelease build pipeline.

### Fixed

- Restored the storage-to-Database migration in the test suite (tests now use
  the `Database` class); repaired pre-existing type-check, lint, and test
  failures that were blocking CI.

## [Unreleased]

### Added

- Open source release-readiness foundation: security policy, code of conduct,
  issue/PR templates, dependency automation, and Docker deployment templates.

## [0.2.1] - 2026-08-05

### Added

- Open source preparation: aligned license metadata with the MIT LICENSE file,
  added contribution guidelines (CONTRIBUTING.md), and pointed release
  metadata at the public `pillardash-oss/codeinoven` repository.

## [0.2.0] - 2026-07

### Added

- Initial public-facing feature set of the coordinated agentic engineering
  workstation (see README for the full feature list).
