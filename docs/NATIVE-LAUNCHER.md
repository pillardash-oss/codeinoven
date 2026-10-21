# The native splash and the two executables

The app ships a dependency-free splash window that covers the gap between launch
and Chromium's first painted frame. It is small enough to state in one place,
because getting the names wrong changes what macOS shows the user.

## macOS: one app, one name

`CodeInOven.app/Contents/MacOS/CodeInOven` is the Electron runtime, and it is the
bundle's `CFBundleExecutable`. That is deliberate: this process is the product.
It owns the windows, the menu bar item, the embedded browser, meetings, and every
capture permission (screen, camera, microphone), and its name is the name the
operating system shows.

Two consequences decide the layout:

- **Launch Services, privacy dialogs and Activity Monitor** resolve the app from
  the bundle's executable name. A supervisor binary carrying a different name is
  what people see in "would like to record this computer's screen".
- **Squirrel** (the macOS updater) names the installed bundle after its
  executable. A bundle whose executable is `CodeInOven Launcher` is installed as
  `/Applications/CodeInOven Launcher.app` on the next update, no matter what the
  DMG contained.

So the splash never owns the entry point on macOS. `scripts/native-splash/after-pack.js`
compiles it to `CodeInOven.app/Contents/Helpers/CodeInOven Splash`, the app spawns
it at startup (`src/main/system/native-splash-handoff.ts`), and it exits once the
app connects to the handoff socket it reported on file descriptor 1. It appears
nowhere else: not in the Applications folder, the Dock, or a privacy prompt.

`mac-sign.js` keeps two code identities, both for compatibility rather than
appearance:

| Signed object | Identifier | Why |
| --- | --- | --- |
| the app bundle (and the runtime sealed into it) | `CodeInOven-electron` | Squirrel validates updates against the running process's designated requirement, and existing installs carry that identifier |
| the same bundle, requirement | `(com.pillardash.codeinoven or CodeInOven-electron)` | lets a later move to the canonical identifier happen without stranding existing installs |

The identifier users and notifications see is the bundle identifier from
`Info.plist` (`com.pillardash.codeinoven`), which never changes. `codesign` seals
`Foo.app/Contents/MacOS/Foo` as the bundle, so a per-file identifier on the
runtime does not survive the seal and is not attempted.

## Windows and Linux: the supervisor owns the entry point

`CodeInOven.exe` (and the Linux `codeinoven`) remains the public executable and a
tiny supervisor: it paints the splash first, then spawns the Electron runtime
(`CodeInOven-electron.exe`, `codeinoven-electron`) as a child with a fresh PID,
supervises it, and exits with its status. It passes the splash handoff socket in
`CODEINOVEN_NATIVE_SPLASH_ENDPOINT`, which the app reads at startup.

Because that supervisor is the executable Explorer, the taskbar, the Start menu
shortcut and toast notifications resolve, `after-pack.js` stamps it with the app
icon and version block from `build/icon.ico`; electron-builder's own stamp lands
on the Electron binary before the hook moves it aside.

`CODEINOVEN_DISABLE_NATIVE_SPLASH=1` skips the splash on every platform.

## Verifying a packaged build

```bash
bunx electron-builder --mac --dir -c.forceCodeSigning=false -c.mac.identity=- \
  -c.mac.hardenedRuntime=false -c.mac.notarize=false

# The bundle name, the executable name and the helper must be these:
plutil -p dist/mac-arm64/CodeInOven.app/Contents/Info.plist | grep CFBundleExecutable
ls dist/mac-arm64/CodeInOven.app/Contents/MacOS dist/mac-arm64/CodeInOven.app/Contents/Helpers
codesign -dv --verbose=4 dist/mac-arm64/CodeInOven.app/Contents/MacOS/CodeInOven
```

`bun run smoke:packaged --target mac --app-dir dist/mac-arm64` boots the packaged
app and fails if the executable the OS would start is missing.
