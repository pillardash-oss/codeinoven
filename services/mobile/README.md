# CodeInOven mobile

The iOS and Android client. SvelteKit builds a static single page app, Capacitor
wraps that build in a native shell, and the Go service in `../backend` serves the
account and the content the app reads.

The design this implements is settled: the ivory and obsidian palette, Oven Box at
weight 200, 2px corners, hairline rules, and the handcrafted icon set from
`@pdslng/cio-icon`. Nothing here invents a second visual language.

## What the app does

| Screen       | Read and write                                                                           |
| ------------ | ---------------------------------------------------------------------------------------- |
| Sign-in      | Google and GitHub through the system browser, email and password as the fallback         |
| Threads      | Every thread of the project in scope, pinned first, each row carrying its project's mark |
| Projects     | One foldable strip per project; opening a strip reads its threads in place               |
| Chats        | The chats panel; this service does not carry chats yet, and the screen says so           |
| New thread   | A name and a project, created through `POST /v1/threads`, then opened                    |
| Conversation | One thread's transcript, the composer that queues a prompt, and a drawer of thread facts |
| Settings     | The account, this device, the device list with revocation, appearance, and sign out      |

Deliberately absent, because the desktop keeps them: a terminal, a file tree, the
spec studio, diff review, design and video work, multi-Oven orchestration, model
selection, and skill or MCP editing.

## Running it

One command runs both ends: it creates the database when it is missing, builds and
starts the service, waits until it answers, then boots the emulator, builds the web
bundle with the API origin baked in, installs the APK and launches it. Ctrl+C stops
the service.

```sh
bun run services:mobile:android             # backend + emulator + install + launch
bun run services:mobile:android -- --seed   # seed the demo account and content first
bun run services:mobile:android -- --port 8090  # move both ends when 8081 is taken
bun run services:mobile:android -- --backend-only
```

The same command is `bun run dev:android` inside `services/mobile`. It refuses to
start when the port already has a listener, because a second service on that port
answers some requests and drops the rest, which reads as a broken app.

### Two terminals, two logs

The Actions panel carries the same two ends separately, so each keeps its own log:
**Mobile · Backend** runs `backend-dev.sh` in the foreground, **Mobile · Android App**
runs `android-app.sh` and then stays attached to the app's own device log, so the run
keeps showing what the app does while you use it. Stopping the run ends the log and
leaves the emulator and the app running. Start the backend, then the app. On the
command line:

```sh
bun run services:mobile:backend             # terminal 1: the service and its log
bun run services:mobile:app                 # terminal 2: build, install, launch, follow the app log
bun run services:mobile:app -- --no-follow  # install and launch, then return
bun run services:mobile:backend -- --seed   # seed the demo account and content first
bun run services:mobile:app -- --port 8090  # follow a service moved off 8081
```

For the browser instead of the phone:

```sh
bun run services:db:setup      # once
bun run services:backend:dev   # terminal 1
cd services/mobile && bun run dev   # terminal 2, http://127.0.0.1:5174
```

The dev server proxies `/api/*` to the backend, so the browser build and the
native build ask for the same paths.

The Android build needs a JDK 21 or newer. `android-emulator-dev.sh` resolves one
itself (Android Studio's JBR, then `java_home`, then `CIO_JAVA_HOME`) and prints
which it chose, because a shell profile that pins an older `JAVA_HOME` makes Gradle
fail with `invalid source release: 21`.

Sign in with Google, GitHub, or the seeded demo account
(`bun run services:backend:seed` prints it).

### Provider sign-in in the app

Google and GitHub sign in through the system browser, because a provider will not
render inside a WebView. The callback returns on `codeinoven://auth`, and the app
trades its one-time code for this device's session. That needs the dev backend on
`http://localhost:8081` with the provider callback URLs registered for that host:

```sh
adb reverse tcp:8081 tcp:8081
VITE_API_BASE=http://localhost:8081 bun run build
```

Without those credentials the two buttons explain that the server has no provider
configured instead of failing in the browser, and email sign-in still works.

## A real device

A phone cannot reach the host's loopback address, so the API origin is a build
input:

```sh
VITE_API_BASE=http://192.168.1.20:8080 bun run build
```

The backend must listen on `0.0.0.0:8080` for that to work, and the adb or Xcode
target must be on the same network.

## Native projects

```sh
cd services/mobile
bun run native:add:ios       # once
bun run native:add:android   # once
bun run native:sync          # copy build/ into both shells
bun run native:ios
bun run native:android
```

The generated `ios/` and `android/` folders are committed on purpose: both carry
hand edits (icons, `Info.plist`, `AndroidManifest.xml`, signing) that regenerating
would discard. `bun run native:sync` refreshes the web assets without touching
them.

## Files that matter

| Path                               | Owns                                                            |
| ---------------------------------- | --------------------------------------------------------------- |
| `src/app.css`                      | The whole brand sheet, ported from the approved design          |
| `src/lib/api/client.ts`            | The only place a request is built; every screen goes through it |
| `src/lib/api/types.ts`             | The wire types, named exactly like the desktop's                |
| `src/lib/api/status.ts`            | Thread status to label, tone, icon and inbox group              |
| `src/lib/stores/session.svelte.ts` | The token, the account, and signing in and out                  |
| `src/lib/components/`              | The shared chrome: bar, navigation, project mark, thread row    |
| `src/routes/`                      | Projects, threads, conversation, account, sign-in               |

`#lib/*` resolves to `src/lib/*` (SvelteKit 3 replaced the `$lib` alias).

## What is not built yet

- **Offline cache.** The plan puts a SQLite read cache and an outbox on the device.
  Today the app reads from the service and shows an honest error when it cannot
  reach it, with a retry. Nothing pretends to be cached.
- **Answer streaming.** A prompt is queued for the Oven; the conversation screen
  polls for the answer. WebSockets and a live run stream are a later phase.
- **Push notifications**, deep links back into a thread, attachment upload, and
  search across the store.
