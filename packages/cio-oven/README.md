# cio-oven

Turn a machine into a CodeInOven Oven. One command installs the durable Oven
service, starts it in the background, and prints the registration code you paste
into CodeInOven.

```sh
npx cio-oven start
```

Works on Linux, macOS, and native Windows. Node.js 22 or later must already be
installed, since the Oven service runs on it.

## Commands

| Command                | What it does                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `npx cio-oven start`   | Install and start the Oven service in the background, then print the registration code. |
| `npx cio-oven stop`    | Stop the Oven service.                                                                  |
| `npx cio-oven status`  | Show whether the service is installed and running.                                      |
| `npx cio-oven restart` | Replace the running service with this release, keeping registration.                    |
| `npx cio-oven help`    | Show usage.                                                                             |

`start` prompts for the Oven name, the SSH port the app should connect on, and
whether to provision a dedicated SSH key. Every answer has a default, and every
question has a flag, so it can also run unattended:

```sh
npx cio-oven start --yes
npx cio-oven start --yes --name "build-box" --port 2222
npx cio-oven start --yes --no-identity
```

## Options

| Option                         | Meaning                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `--name <name>`                | Oven name shown in the app. Defaults to this machine's host name.                                      |
| `--port <port>`                | SSH port the app connects on. Defaults to the port in this machine's `sshd_config`, else 22.           |
| `--identity` / `--no-identity` | Provision a dedicated ed25519 key for this Oven, or register against the SSH identity you already use. |
| `--data-root <path>`           | Where the service keeps its state. Defaults to `~/.config/pillardash/codeinoven/ovens`.                |
| `--force`, `-f`                | Replace a running service without asking. Refuses while runs are active.                               |
| `--yes`, `-y`                  | Accept every default without prompting.                                                                |
| `--json`                       | Machine-readable output for `status`, `start`, and `stop`.                                             |
| `--version`, `-v`              | Print the version.                                                                                     |
| `--help`, `-h`                 | Show usage.                                                                                            |

## What it does to the machine

Everything it writes lives under one removable directory in the user's home,
`~/.config/pillardash/codeinoven/ovens`, inside the CodeInOven namespace rather
than beside it, and exactly where CodeInOven keeps its own Oven state:

- `service.mjs`, the Oven service bundle the app talks to, verified by SHA-256
  after it is written and replaced only when it verifies.
- `service.pid`, the running service's lock.
- `agent-registration.json`, a copy of the registration code, owner-readable only.

With a dedicated key it also creates `~/.ssh/codeinoven-oven-agent` and
authorizes the public half in `~/.ssh/authorized_keys`. It never reads or
changes your existing `~/.ssh/config`, `authorized_keys`, or login identity. On
Windows, when the account is an administrator, OpenSSH reads the machine-wide
`administrators_authorized_keys` instead, so the key is authorized there too;
when that file needs an elevated shell, the command prints the exact line to add.

The service keeps running after the command exits, after you log out, and after
CodeInOven closes. `npx cio-oven stop` is what stops it.

## Registration

`start` prints a code that starts with `codeinoven-oven-agent-v1:`. Paste it into
CodeInOven at **Settings → Ovens → Add via agent**. The same dialog shows the
machine, the SSH account, and the key fingerprint before anything is saved.

Treat the code and the saved `agent-registration.json` as secrets: the dedicated
private key is inside them.

## Requirements

- Node.js 22 or later.
- An SSH server reachable from the machine running CodeInOven, on the port you
  choose. `start` warns when nothing is listening on that port locally.
- OpenSSH (`ssh-keygen`) when provisioning a dedicated key. Without it, run
  `start --no-identity`.

## Publishing

This package is built from the CodeInOven repository, and it is not hand-edited.
Its embedded service bundle and the revision it reports to the app come from one
app build. Its own version is independent of the desktop app's, which the release
pipeline bumps on its own; releasing the CLI never moves it:

```sh
bun run build              # produces out/main/oven-service.mjs
bun run oven:cli:build     # writes packages/cio-oven/dist from that bundle
bun run oven:version:bump  # bumps only packages/cio-oven/package.json
cd packages/cio-oven
npm publish
```

`prepack` runs the same build, so a publish can never ship a stale bundle.
