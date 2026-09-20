/**
 * Presentation and contract for the app-owned Android device skill
 * (`cio:adb`, `src/lib/utility-ids.ts`).
 *
 * This capability is knowledge, not a tool. There is no executor, no operation
 * catalog and no gateway service behind it: it is an ordinary app-owned utility
 * of kind `skill`, so a turn reaches it exactly the way it reaches `cio:scope`,
 * by searching the gateway and activating the result, and activation hands back
 * the playbook below.
 *
 * That shape is deliberate. A session that never touches a phone carries none
 * of this text, and the text itself is the only thing that has to change when
 * adb, Android or a project's own tooling moves on: it is seeded data the user
 * can edit in Utilities, not a compiled surface that has to be kept in step
 * with thirteen operation schemas. The agent already has bash, so it already
 * has everything the recipes need.
 *
 * Every command in the playbook was run against a real target (Samsung A54,
 * Android 16, over USB) or an emulator before it was written down. Keep it that
 * way: a recipe that was not verified does not belong here.
 */

/** Display name shown in a search result, the Utilities UI and the thread bank. */
export const ADB_CAPABILITY_NAME = 'Android device control (adb)'
/**
 * Search query advertised in the turn instructions, so no surface hardcodes a
 * term. One word on purpose: the gateway scores a query by token, but the
 * registry's own search matches the query as a substring, and a query that only
 * works on one of the two paths is a discovery bug waiting for a maintainer.
 */
export const ADB_CAPABILITY_SEARCH_QUERY = 'adb'
/**
 * Registry description: the search result and bank summary. Carries the words an
 * agent actually searches with (adb, android, device, emulator, uiautomator,
 * tap, type, screenshot, logcat, install) so discovery never depends on the
 * playbook already being in context.
 */
export const ADB_CAPABILITY_SUMMARY =
  'Working playbook for driving an Android target attached over adb, on USB or an emulator: locating the adb binary, picking a serial, reading the uiautomator tree and why a thin tree is not a platform limit, choosing a selector, tapping and typing with the field read back, proving state survived a cold start, screenshot cost and when pixels beat the tree, logcat and dumpsys, building and installing, and one-target-at-a-time discipline. Knowledge only: it exposes no tool, so use it with ordinary bash commands.'

/**
 * The capability contract, returned by activation and by the post-compaction
 * docs lookup. This is the only place an agent reads how to work a target, so
 * it must be complete on its own: the setup that survives across tool calls,
 * the recipes, the traps that cost the most time, and the context discipline
 * that keeps a device session affordable.
 */
export const ADB_CAPABILITY_DOCS = `Driving an Android target with adb.

You already have bash, so you already have the capability. This text is a playbook, not a tool: there is nothing to invoke. Find adb once, keep the recipes below, and the device stops costing you rediscovery. Every command here was verified against a plugged Samsung A54 on Android 16 and against an emulator.

## The two rules that matter most

1. A thin or empty accessibility tree is almost never a platform limit. It is occlusion (a dialog in the way), a page still rendering, a node that is off screen, or the app not being the focused window. Dump, wait, dump again, and check what is actually focused before concluding anything. A WebView app exposes its DOM nodes to uiautomator with no accessibility service enabled, so never go enabling one to "fix" a thin tree.
2. A screenshot is expensive to put in context (a 1080x2340 PNG came back as about 49KB of payload in a previous session); the same screen as a filtered node list is a few hundred characters. Read the tree first and reach for pixels only when the question is genuinely visual.

## 1. Find adb once and keep it for the session

adb is usually not on PATH, and every tool call is a fresh shell, so an \`export\` in one call is gone in the next. Write a wrapper into the project scratch space once, then every later call is \`"$A"\`.

\`\`\`bash
mkdir -p .cio/tmp/adb
cat > .cio/tmp/adb/adb <<'SH'
#!/bin/sh
for c in "\${ANDROID_HOME:-}/platform-tools/adb" "$HOME/Library/Android/sdk/platform-tools/adb" "$HOME/Android/Sdk/platform-tools/adb" "/opt/homebrew/bin/adb" "/usr/local/bin/adb"; do
  [ -x "$c" ] && exec "$c" "$@"
done
exec adb "$@"
SH
chmod +x .cio/tmp/adb/adb
A=.cio/tmp/adb/adb; "$A" version
\`\`\`

## 2. Pick the target, then record it

\`\`\`bash
A=.cio/tmp/adb/adb; "$A" devices -l
\`\`\`

\`device\` is ready, \`unauthorized\` means the phone is showing the USB debugging prompt and nothing else will work until it is accepted, \`offline\` needs the reconnect ladder below. More than one line means always pass \`-s\`.

\`\`\`bash
"$A" -s RZCW61ATJDF get-state && echo RZCW61ATJDF > .cio/tmp/adb/target
S=$(cat .cio/tmp/adb/target)   # in every later call
\`\`\`

Wireless: \`"$A" pair <host:port>\` (code from the phone's developer options) then \`"$A" connect <host:port>\`. Emulator: \`emulator -list-avds\`, start with \`emulator -avd <name> -no-snapshot-load\`, serial \`emulator-5554\`.

Reconnect ladder, in order: re-list, \`"$A" reconnect offline\`, \`"$A" kill-server && "$A" start-server\`, then reseat the cable.

## 3. Read the screen

Check focus and occupancy before you trust any tree:

\`\`\`bash
A=.cio/tmp/adb/adb; S=$(cat .cio/tmp/adb/target)
"$A" -s "$S" shell dumpsys window | grep -m2 -E 'mCurrentFocus|mFocusedApp'
"$A" -s "$S" shell dumpsys activity activities | grep -m1 -i 'topResumedActivity'
\`\`\`

Then dump. \`exec-out\` is required: plain \`adb shell\` sends \`/dev/tty\` to the device and you only get the status line back. uiautomator appends its own message (with its own misspelling) with no newline, so strip it.

\`\`\`bash
"$A" -s "$S" exec-out uiautomator dump /dev/tty | sed 's/UI hierchary dumped to: [^<]*$//' > .cio/tmp/adb/ui.xml
wc -c .cio/tmp/adb/ui.xml
\`\`\`

Add \`--compressed\` for a smaller dump (about 20% smaller on a real WebView screen, and the ratio is tree-dependent) that still carries text, classes, labels and resource ids. Either way the dump is one single line of XML, so count with \`grep -o ... | wc -l\` and never with \`grep -c\`.

Turn it into actionable nodes. This is the snippet sessions rewrite from scratch every time:

\`\`\`bash
python3 - <<'PY'
import re, xml.etree.ElementTree as ET
tree = ET.parse('.cio/tmp/adb/ui.xml')
for node in tree.iter('node'):
    b = [int(v) for v in re.findall(r'\\d+', node.get('bounds') or '')]
    if len(b) != 4 or (b[2] - b[0]) * (b[3] - b[1]) == 0:
        continue  # [0,0][0,0] is off screen or not laid out: scroll, then dump again
    label = node.get('text') or node.get('content-desc') or node.get('resource-id') or ''
    if not label and node.get('clickable') != 'true':
        continue
    print(f"{(b[0]+b[2])//2},{(b[1]+b[3])//2}  {node.get('class','').rsplit('.',1)[-1]:<10} {label[:60]}")
PY
\`\`\`

If the tree came back thin, do not read it as a limit. Dump again after a second (\`sleep 1\`), and look for what is on top:

\`\`\`bash
grep -o 'class="android.app.[A-Za-z]*"' .cio/tmp/adb/ui.xml | sort -u
grep -o 'package="[^"]*"' .cio/tmp/adb/ui.xml | sort -u
\`\`\`

An \`android.app.AlertDialog\`, or a package that is not the app under test, means an overlay is pruning the nodes behind it. Check the package before blaming an overlay: a WebView app draws its own in-page dialogs, and those carry the same class with the app's package, so the real signal is a foreign package or the app's own expected nodes going missing. Handle the dialog or ask the user; do not hammer the app underneath.

## 4. Select a node

- \`content-desc\` is the accessibility label: a Svelte or React \`aria-label\` lands there, and it is the most stable handle in a WebView app.
- \`resource-id\` in a Capacitor or React Native app often comes straight from the DOM \`id\` attribute. If it ends in a UUID or a timestamp it is generated per item and will not repeat: match the label or the text instead.
- Text is elided with an ellipsis when it is long, so never match a whole sentence.
- Bounds \`[x1,y1][x2,y2]\` are absolute pixels on the device; the tap point is the centre from the parse above.

## 5. Act

\`\`\`bash
"$A" -s "$S" shell input tap 540 1812
"$A" -s "$S" shell input swipe 540 1800 540 700 300
"$A" -s "$S" shell input keyevent 66    # 66 ENTER, 4 BACK, 3 HOME, 67 DEL, 123 END
\`\`\`

Typing has four limits, all of them silent if you ignore them:

- \`input text\` takes no literal spaces. Every space must be \`%s\`, and a literal \`%s\` in the text cannot be typed at all: split the operation around it.
- Only printable ASCII survives the IME. Accents, smart quotes and emoji are dropped, so use a clipboard route for those.
- A newline cannot be typed. Send one separate ENTER key event per line break.
- Nothing types into a locked screen. Check \`"$A" -s "$S" shell dumpsys window | grep mDreamingLockscreen\`, then \`"$A" -s "$S" shell wm dismiss-keyguard\`, and if it is PIN or biometric locked, ask the user to unlock it.

\`\`\`bash
"$A" -s "$S" shell input text 'Hello%sworld'
\`\`\`

To clear a field: tap it, \`input keyevent 123\`, then DEL as many times as the field can hold.

## 6. Verify, never assume

The evidence standard that makes device work trustworthy:

1. Read the field back before you submit anything.
2. After the action, dump again and confirm the control disappeared or the item appeared. Do not infer success from the absence of an error.
3. To prove something persisted, force-stop, relaunch, and show it is still there while the process that rendered it is not the process that wrote it:

\`\`\`bash
"$A" -s "$S" shell am force-stop com.example.app
"$A" -s "$S" shell cmd package resolve-activity --brief com.example.app | tail -1   # Android 16 prints a priority= line first
"$A" -s "$S" shell am start -W -n com.example.app/.MainActivity   # prints TotalTime and LaunchState
"$A" -s "$S" shell pidof com.example.app
"$A" -s "$S" shell dumpsys activity exit-info com.example.app | grep -i -m2 'reason\\|description'
\`\`\`

\`exit-info\` says why the previous process died (\`reason=3 (LOW_MEMORY)\` on a WebView sandbox process is ordinary memory pressure, not your bug).

## 7. Read pixels only when you must

\`\`\`bash
"$A" -s "$S" exec-out screencap -p > .cio/tmp/adb/screen.png
\`\`\`

Screenshot first, read the file after, and delete it when you are done. If fine detail does not matter, shrink it before reading (\`sips -Z 720 .cio/tmp/adb/screen.png\` on macOS). Never enumerate the directory afterwards.

## 8. Logs and diagnostics

\`\`\`bash
"$A" -s "$S" shell logcat -c
"$A" -s "$S" shell logcat -d -t 300 --pid="$("$A" -s "$S" shell pidof com.example.app)"
"$A" -s "$S" shell dumpsys meminfo com.example.app | head -25
\`\`\`

Always \`-d\` to dump and exit: a bare \`logcat\` streams forever and hangs the call until it times out. \`-t N\` caps the tail and \`--pid\` keeps it to the app.

## 9. Build, install, launch

Prefer the project's own runner when it has one (an Expo prebuild, a \`just\`/\`make\`/\`bun\` task, a mobile runner tool). adb is for observing and driving the target, not for re-implementing a build.

\`\`\`bash
./gradlew :app:assembleDebug
"$A" -s "$S" install -r -g path/to/app-debug.apk
\`\`\`

No Gradle file, only an APK: \`aapt2 dump packagename <apk>\` (or \`apkanalyzer manifest application-id\`) gives the package, and \`cmd package resolve-activity --brief <pkg>\` gives the launch component (take the last line). A dev server on the machine reaches the device over USB with \`"$A" -s "$S" reverse tcp:5173 tcp:5173\`.

## 10. One target at a time

A phone is shared mutable state. Three sessions tapping one screen at once has already produced tap coordinates recorded against the wrong process and a persistence proof that had to be thrown away.

\`\`\`bash
LOCK=.cio/tmp/adb/lease
mkdir "$LOCK" 2>/dev/null && echo "$$" > "$LOCK/holder" || { echo "held by $(cat "$LOCK/holder" 2>/dev/null)"; exit 1; }
# ... work ...
rm -rf "$LOCK"
\`\`\`

That lock only covers this project. If another project on this machine may use the same phone, ask the user before you start, and re-check \`mCurrentFocus\` and \`pidof\` right before every action: if the screen or the process changed under you, stop and ask rather than continuing on stale coordinates.

## 11. Context discipline

This is where device sessions get expensive, not in the commands.

- Extract, do not paste. Grep the dump for the one field you need instead of returning the tree.
- Never \`ls -la\` a scratch directory holding screenshots: one such listing cost 40KB in a previous session.
- Anything on a real phone is user data. Take the label, the coordinate or the package you need and leave message text out of the answer unless the user asked for it.

## Traps, in one list

- uiautomator appends \`UI hierchary dumped to:\` (their misspelling) to the XML with no newline; strip it before parsing.
- \`adb shell uiautomator dump /dev/tty\` prints only that status line. Use \`exec-out\`.
- The dump is one line: \`grep -o\`, not \`grep -c\`.
- \`[0,0][0,0]\` bounds mean off screen or not laid out: scroll into view and dump again. A tap at 0,0 hits nothing.
- A dialog in the way, or a foreign package on top, prunes the app's nodes from the tree. Check the package first: a WebView app's own in-page dialog carries the app's package too.
- \`input text\`: \`%s\` for spaces, ASCII only, no newlines, a literal \`%s\` is untypeable.
- \`logcat\` without \`-d\` never returns.
- Android 16 dropped \`mResumedActivity\`: \`dumpsys activity activities\` shows \`topResumedActivity\` instead, so a grep for the old field silently returns nothing.
- \`cmd package resolve-activity --brief\` prints a \`priority=...\` preamble on Android 16; take the last line.
- \`unauthorized\` in \`devices -l\` is a prompt on the phone, not a broken cable.
- Emulators repeat state unless you start them with \`-no-snapshot-load\`.
- \`exec-out\` is the habit to keep: it is required for \`uiautomator dump /dev/tty\` (plain \`shell\` sends that path to the device and you get only the status line) and it is what carries binary safely. Do not assume \`shell\` mangles line endings: on current adb both routes returned identical bytes.`
