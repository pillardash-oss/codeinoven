# CodeInOven mobile

The iOS and Android client. SvelteKit builds a static single page app, Capacitor
wraps that build in a native shell, and the Go service in `../backend` serves the
account and the content the app reads.

The design this implements is settled: the ivory and obsidian palette, Oven Box at
weight 200, 2px corners, hairline rules, and the handcrafted icon set from
`@pdslng/cio-icon`. Nothing here invents a second visual language.

## What the app does

| Screen | Read and write |
| --- | --- |
| Projects | Every project as a foldable strip, its threads inside it, and the activity cluster above them |
| Threads | All threads in one run ordered by what needs the user first, with inbox grouping by status |
| Conversation | One thread's transcript, a composer that queues a prompt for an Oven, and a drawer of thread facts |
| Account | The account, this device, the device list with revocation, appearance, and sign out |

Deliberately absent, because the desktop keeps them: a terminal, a file tree, the
spec studio, diff review, design and video work, multi-Oven orchestration, model
selection, and skill or MCP editing.

## Running it

The backend has to be running first. From the repository root:

```sh
bun run services:db:setup      # once
bun run services:backend:dev   # terminal 1
bun run services:mobile:dev    # terminal 2
```

The dev server is at `http://127.0.0.1:5174` and proxies `/api/*` to the backend,
so the browser build and the native build ask for the same paths.

Sign in with the seeded demo account (`bun run services:backend:seed` prints it),
or create an account in the app.

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

| Path | Owns |
| --- | --- |
| `src/app.css` | The whole brand sheet, ported from the approved design |
| `src/lib/api/client.ts` | The only place a request is built; every screen goes through it |
| `src/lib/api/types.ts` | The wire types, named exactly like the desktop's |
| `src/lib/api/status.ts` | Thread status to label, tone, icon and inbox group |
| `src/lib/stores/session.svelte.ts` | The token, the account, and signing in and out |
| `src/lib/components/` | The shared chrome: bar, navigation, project mark, thread row |
| `src/routes/` | Projects, threads, conversation, account, sign-in |

`#lib/*` resolves to `src/lib/*` (SvelteKit 3 replaced the `$lib` alias).

## What is not built yet

- **Offline cache.** The plan puts a SQLite read cache and an outbox on the device.
  Today the app reads from the service and shows an honest error when it cannot
  reach it, with a retry. Nothing pretends to be cached.
- **Answer streaming.** A prompt is queued for the Oven; the conversation screen
  polls for the answer. WebSockets and a live run stream are a later phase.
- **Push notifications**, deep links back into a thread, attachment upload, and
  search across the store.
