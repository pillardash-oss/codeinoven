/**
 * Presentation and contract for the app-owned Android target utility
 * (`cio:adb`, `src/lib/utility-ids.ts`).
 *
 * The capability is deliberately **not** a tool in any harness's tool list, and
 * no surface injects its contract: a session that never touches a phone must not
 * pay for the schema. It is an ordinary app-owned utility instead, so an agent
 * reaches it exactly the way it reaches `cio:scope`: search the gateway,
 * activate the result, then invoke it. The contract below enters context at
 * activation and nowhere else, and only because the turn asked for it.
 *
 * Every transport derives its tool list from `GATEWAY_TOOLS`, so keeping the
 * capability out of that catalog is what keeps it out of all of them.
 *
 * Naming rule: this module and everything behind it says `target`, never
 * `device`. `device` already means a paired phone running the CodeInOven PWA
 * (`remote_devices`, `RemoteDeviceInfo`, `src/renderer/lib/remote/device-identity.ts`).
 */

/** Display name shown in a search result, the Utilities UI and the thread bank. */
export const ADB_CAPABILITY_NAME = 'Android target control (adb)'
/** Search query advertised in the turn instructions, so no surface hardcodes a term. */
export const ADB_CAPABILITY_SEARCH_QUERY = 'android'
/**
 * Registry description: the search result and bank summary. States the lease
 * rule in the first sentence an agent can see, before it has activated anything.
 */
export const ADB_CAPABILITY_SUMMARY =
  'Inspect and drive an Android target attached over adb, on USB or an emulator: list targets, claim one exclusively, read the accessibility view tree, locate controls by resource id or aria label, tap, type, press keys, capture screenshots, and wait for the screen to change. The app resolves the adb binary, so never call adb directly and never export an SDK path. Claim the target first: the lease is what stops two threads typing into the same phone at once.'

/** Operation names. Kept as constants so the docs, the gateway schema and the
 *  service dispatch cannot drift apart. */
export const ADB_OPERATIONS = [
  'targets',
  'claim',
  'release',
  'status',
  'dump',
  'find',
  'tap',
  'type',
  'key',
  'start',
  'screenshot',
  'wait_for',
  'reconnect'
] as const

export type AdbOperation = (typeof ADB_OPERATIONS)[number]

/** Read-only operations, so a caller cannot be surprised by what touches the target. */
export const ADB_READ_OPERATIONS: readonly AdbOperation[] = [
  'targets',
  'status',
  'dump',
  'find',
  'screenshot'
]

/** How much of a node's user-visible text a result carries back. */
export const ADB_TEXT_MODES = ['omit', 'length', 'include'] as const
export type AdbTextMode = (typeof ADB_TEXT_MODES)[number]

/** Default lease length. Long enough for a real flow, short enough that a dead
 *  turn releases the phone without anyone clearing state by hand. */
export const ADB_DEFAULT_LEASE_MINUTES = 15

/**
 * The capability contract, returned by activation and by the post-compaction
 * docs lookup. This is the only place an agent reads how to drive the
 * capability, so it must be complete: every operation, every field it accepts,
 * and the rules that are not negotiable.
 */
export const ADB_CAPABILITY_DOCS = `Drive an Android target attached over adb, on USB or an emulator.

Call it through the gateway invoke tool: utility_id "cio:adb", operation = one of the operations below, input = that operation's fields.

Rules that are not negotiable:

1. Never call adb yourself. Do not run adb through bash, do not pipe it through a shell, and do not export an SDK path. The app resolves the adb binary and the server for you; a shell call you write yourself bypasses the lease and races other sessions.
2. Claim the target before you drive it. \`claim\` takes an exclusive lease so two sessions cannot tap the same phone at once. Every driving operation fails with a plain error while another session holds the lease, and the error names the holder. Release it when you are done, and do not claim a target just to read \`targets\`.
3. Text is user data. \`dump\` and \`find\` omit node text by default. Pass text "include" only when the text itself is what you need, and never paste app content into your report unless the user asked for it.
4. Nothing here is destructive. There is no force-stop, install, uninstall or clear-data operation. If the user needs one, say so and let them act.

Operations:

- targets: no fields. Lists attached phones and emulators with serial, state, model, sdk, size, density and whether a lease is held. Start here. States other than "device" cannot be driven: "unauthorized" means someone must accept the RSA prompt on the phone, and no command gets past it.
- claim: serial?, ttlMinutes? (default ${ADB_DEFAULT_LEASE_MINUTES}). Takes the exclusive lease. Omit serial when exactly one target is attached. Fails if another live session holds it.
- release: no fields. Drops the lease.
- status: no fields. The leased target's screen state, foreground package and activity, keyboard state, size and density. Run this after claiming, before you trust coordinates.
- dump: text? ("omit" default, "length", "include"), detail? ("interactive" default, "full"), limit? (default 120, max 400). The accessibility view tree, as nodes with class, resource id, bounds and flags. It dumps without compression, retries while the tree is still filling in, and reports every window on top of the app. "interactive" keeps the nodes you can act on or read and drops bare layout containers, which is what keeps a dump from flooding your context.
- find: selector, text?, limit? (default 10, max 50). Locates nodes. Selector fields: resourceId, contentDesc, text, textContains, className, editable, clickable, focused, packageName. Returns bounds and the centre point to tap. Selector fields may also be passed at the top level instead of nested under selector.
- tap: selector or x plus y, text? (only to resolve a selector match). Taps a located node's centre, or explicit coordinates.
- type: text, clearFirst?, verify? (default true). Types ASCII into the focused field. Spaces are handled for you. Reads the field back afterwards unless verify is false.
- key: key (name such as BACK, HOME or ENTER, or a numeric keycode).
- start: package? or component? or url? Plus waitForSelector?. Launches an app, an explicit activity, or a deep link.
- screenshot: maxWidth?. Returns the screen as an image, downscaled when the OS tool is available. Prefer this over dumping text when you only need to know what is on screen.
- wait_for: selector, state ("present" or "absent"), timeoutMs? (default 10000), pollMs? (default 500). Polls the tree until the condition holds. Use it instead of sleeping.
- reconnect: serial?. Runs the recovery ladder when the target vanishes: check the list, then the USB bus, then reconnect, then re-check. Reports what each step returned.

How to work a screen, in order:

1. \`targets\`, then \`claim\`.
2. \`status\` to confirm the app is foreground and the screen is awake.
3. \`find\` by resource id or contentDesc for the control you want. Labels come from the app's own source, so read the source and use the exact label.
4. \`tap\` the match. Never chain two taps without reading the tree between them.
5. \`type\` the body, then check the read-back before you press anything that submits.
6. \`wait_for\` the expected change. A tap that returns success can still have landed on a control that did nothing.

Two traps worth knowing, both observed in real sessions:

- A first dump can look nearly empty while the accessibility tree is still being built, and it can also be pruned when a native dialog sits on top. \`dump\` retries and warns about both. Never conclude that a screen has no controls from one dump.
- \`type\` goes through the keyboard and only carries ASCII. An apostrophe, an accented letter, a smart quote or an emoji is dropped or mangled, and the operation reports the warning rather than pretending it worked.`
