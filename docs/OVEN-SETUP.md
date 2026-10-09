# Remote Oven setup

Oven setup prepares an SSH Oven for CodeInOven runs. It does not perform full setup or package upgrades on the Local Oven. Setup supports Linux, macOS, and native Windows on x64 and arm64. The remote service requires Node.js 22 or later.

An Oven is driven the same way whatever its operating system. On a native Windows Oven, whether OpenSSH starts cmd.exe or PowerShell as the login shell, every managed command the app runs is carried as an encoded PowerShell 5.1 program, so a Windows Oven takes the same install, probe, run, workspace, root-operation, harness-management, and setup traffic a POSIX Oven takes. No extra shell configuration is needed on the Oven.

## Run setup

1. Add and test the SSH Oven in Settings → Ovens.
2. Open **Setup**. The app reads the OS, architecture, package manager, privilege, Git, curl, Node.js, npm, reboot state, and installed harness inventory without changing the host.
3. Choose harnesses and optional GitHub identity settings. Saved accounts and portable configuration for selected harnesses synchronize automatically. Choose the account to use when sending a message.
4. Select **Start setup** to authorize package upgrades and the selected installs. Package registry refresh and package upgrades run before Node bootstrap. OS release upgrades and reboots are never automatic.
5. Follow progress in the global docked setup panel. Leaving Settings or switching views keeps the panel and progress tracking alive. Failed steps include their error. Retry rechecks completed steps and resumes work that still needs attention.

Harness install steps show live download/install progress in the setup panel and dock chip. Percentages come from installer-reported percentages or transferred-byte totals. Installers such as npm that do not provide a measurable total show an indeterminate stage instead. Raw installer output is not copied into progress records. Before a stage is reported, setup shows Starting installer, without a percentage. Failure clears the active progress indicator.

Linux system package commands run directly as root or through sudo for other users. Password-authenticated Oven connections use the vaulted login password through SSH stdin when sudo requires authentication. The elevated command receives no password input. Other connections require passwordless sudo. Remote command failures are reported separately from SSH connection and trust errors.

## Add a machine with the Oven agent

**Settings → Ovens → Add via agent** registers a machine that prepared itself, without this computer reaching it first. The first step shows the one command to run on the machine:

```sh
npx cio-oven start
```

The command needs Node.js 22 or later already installed. It writes the same service bundle this app would push, verifies its SHA-256, starts the durable service, and prints a registration code; the service keeps running after the shell exits and after this app closes. Name the machine's SSH port in the **SSH port on the machine** field to put it in the command, as in `npx cio-oven start --port 2222`; leave it empty and the command uses the machine's own `sshd` port. The command and its flags are described in **Add a machine with one command** below.

Paste the printed code into the second step of the same dialog. **Check code** shows the machine, the SSH account, the key fingerprint, and whether the machine already runs this app's service, all before anything is saved.

A machine cannot know which of its own addresses this computer can reach: that depends on the network between them. So the code carries every address the machine answers on, ranked with its private LAN addresses first and its host name last, and the dialog dials them and uses the first that connects. The **Address this computer uses** field is prefilled with that answer, and the machine's other candidates sit below it as chips to pick from; nothing needs typing unless you reach the machine under a name it does not know, such as an SSH config alias or a forwarded port. **Register Oven** then stores the descriptor and, when one was provisioned, the key in the encrypted vault, and adds the Oven. An Oven registered from an agent is an ordinary Oven: it gets the same probe, harness inventory, checkout, and run operations as any other.

The SSH port is settled where the truth is available. A port you name, either with `--port` or at the command's prompt, is honoured: it is published only when SSH answers on it, and when nothing does the command refuses with the configuration file and restart command to fix, instead of quietly saving a port you never chose. A port the command detected on its own is only a guess, so it is corrected to the port that answers and the dialog says which was replaced.

**Check code** shows what will be saved. **Test connection**, at the bottom left of the dialog, then opens a real SSH session using the identity from the code and the host and port in the fields, so authentication, host trust, and the remote shell are all confirmed before **Register Oven** stores anything.

The app reaches the machine the same way it reaches any Oven: over SSH to the durable service. Host keys are still trusted through OpenSSH on this computer, so a machine this computer has never connected to needs its host key trusted before the app can reach it. The registration code carries no login password. Treat the printed code and the saved descriptor file as secrets: the dedicated private key is inside them.

**New Oven** is unchanged. Add a machine, test the connection, and install the service from this app. Both paths produce the same Oven.

## Add a machine with one command

The published `cio-oven` CLI prepares a machine from its own shell, without this app reaching it first. It writes the same service bundle, starts the same durable service, and prints the same registration code as the agent installer, so an Oven prepared either way registers identically.

```sh
npx cio-oven start
```

It asks for the Oven name, the SSH port to publish, and whether to provision a dedicated key, then starts the service in the background and prints a code for **Settings → Ovens → Add via agent**. Every question has a flag, so it also runs unattended: `npx cio-oven start --yes`, or `npx cio-oven start --port 2222 --yes --no-identity`. A port you name, with `--port` or at the prompt, is honoured: it is published only when SSH answers on it, and refused with the fix instructions when it does not, rather than being switched to a different port. A port it detected on its own is corrected to the one that answers.

## Windows Ovens

Windows OpenSSH starts `cmd.exe` by default and PowerShell only when it is configured to, so both are driven the same way. Every managed command is carried as a PowerShell program, and the read-only setup probe travels on stdin because the Windows command line cannot hold it: the encoded form exceeded `cmd.exe`'s 8191-character limit and failed with "The command line is too long". A Windows Oven therefore needs no shell reconfiguration.

```sh
npx cio-oven status    # installed and running, with the service revision
npx cio-oven stop      # stop the durable service
npx cio-oven restart   # replace the running service with the current release
```

Everything it writes stays under the same app-managed directory this app uses, `~/.config/pillardash/codeinoven/ovens`. An Oven prepared by an earlier build kept that state in a sibling `codeinoven-oven` directory; the service moves it across the next time it starts, leaving behind only the runtime files of any daemon still running there, and never overwriting an entry the new location already has. A dedicated key is created at `~/.ssh/codeinoven-oven-agent` and authorized for the account; on a Windows administrator account the key is also authorized in the machine-wide `administrators_authorized_keys`, and the command prints the exact line to add when that file needs an elevated shell. Node.js 22 or later must already be installed, because the Oven service runs on it.

The service survives the command exiting, the shell closing, and this app closing. It stops when the user runs `npx cio-oven stop`.

## The Oven clock

Setup matches the Oven's clock to this computer's time zone as a prerequisite step. The zone is read before anything changes, set through the platform's own tool (`timedatectl` on Linux, `systemsetup` on macOS, PowerShell on Windows) and read back afterwards, so a change that did not take is reported instead of assumed. An Oven already on this computer's zone is skipped with that reason. An Oven with no supported way to change its zone, and a Windows Oven whose SSH session is not an administrator, skip the step with the reason rather than failing an otherwise complete setup.

The same action is available at any time from the Oven's row under Settings → Ovens, in its actions menu: **Match your time zone**. The row's Service runtime section names the zone the Oven service reports.

Package updates use the detected package manager: apt, dnf, yum, pacman, Homebrew, winget, Chocolatey, or Scoop. Harness installs use the same documented channel metadata as the Local installer. On Linux and macOS, npm harnesses install into the Oven user’s `.config/pillardash/codeinoven/ovens/harnesses/npm` prefix instead of the system Node prefix. Discovery, verification, runs, updates, and uninstall use that managed location. A selected harness without a supported one-command install path blocks setup rather than running a guessed command.

## Accounts and GitHub

Account credentials are stored in the local encrypted vault. Setup sends selected credentials over the authenticated SSH connection and writes them into the Oven account directory with owner-only permissions. Portable settings are copied automatically alongside saved accounts for the selected harnesses. Transcripts, caches, and local account homes are not copied.

Git setup uses a dedicated key for the Oven, separate from the SSH key used to log in. The private key travels from the encrypted vault through SSH input, never through command arguments or progress records. Use an unencrypted dedicated key, or load an encrypted key into the Oven's own `ssh-agent` before setup. CodeInOven does not send key passphrases to the Oven. The Oven writes the key under its own `.ssh` directory with restrictive permissions. GitHub verification requires strict host-key checking. If `github.com` is not in the Oven's `known_hosts`, compare its fingerprint with the published values shown by CodeInOven and add it on the Oven before retrying. CodeInOven does not accept a host key automatically.

### When no dedicated key is configured

An Oven with no dedicated key still works as the signed-in user. Before a clone or a network Git command, CodeInOven asks OpenSSH which GitHub identity this computer actually authenticates with and mirrors that identity onto the Oven:

- A **file-backed** key is copied whole into `~/.ssh/codeinoven-local-github` with owner-only permissions (0600 on POSIX, an owner-only ACL on Windows). The private key travels over the authenticated SSH connection and is never written to a log, a command argument, or a progress record.
- An **agent-held** key is mirrored as its public half only, and the Oven authenticates through the SSH agent forwarded for that connection.
- GitHub host keys this computer already trusts are copied to `~/.ssh/codeinoven-local-github-known-hosts`, so the Oven inherits trust decisions the user already made for GitHub. CodeInOven never adds a host key on its own.

A dedicated key for that Oven always takes precedence over the mirror. Removing the mirrored files from the Oven is safe: the next operation re-uploads them.

Git failures are reported as the situation that caused them, and never as a bare exit code such as `128`: missing repository access, a rejected identity, GitHub host trust, DNS or network reachability, disk space, or uncommitted local changes.

## Oven checkouts

A remote thread reads and writes one directory on its Oven. Files, Git, the file tree, previews, directory previews, transfers, and the Oven shell all resolve to that same checkout, so no panel can disagree about where the work lives.

- The checkout lives under `~/.config/pillardash/codeinoven/ovens/scopes/<project>/<scope>` on the Oven, keyed by hashes of the project id and the scope id rather than by their text.
- The project identifies the repository: the checkout is cloned from the project's GitHub remote in SSH form. Other Git hosts are not cloned automatically yet.
- The scope identifies the checkout: a scope that owns its own worktree gets its own directory on the Oven. A thread that sets an explicit Oven path keeps it.
- An existing checkout is verified and left untouched. A directory that already holds a different repository is reported, never overwritten.
- Cloning runs on the Oven into a staging directory and is published only after the origin and worktree verify. A failed clone leaves the destination alone.

Each remote thread has an **Oven** panel in the workspace rail. The rail item carries the Oven's own mark and colour and names the Oven on hover. The panel's sidebar header shows that same mark and name, and the panel body is the terminal itself: no second row repeats the Oven's name or the checkout path, and the header carries no close control because the rail icon that opened the panel is what closes it. It opens the app's embedded terminal as an interactive SSH session on the Oven, so the Oven can be inspected and driven directly. The shell starts in that thread's checkout once the checkout exists, and in the Oven user's home directory before that. Terminal sessions are separate per Oven and per scope.

Preparing a checkout is visible while it happens. The first send on a remote thread publishes what the Oven is doing into the working trace: preparing the project, opening the checkout, or cloning the repository. The harness's own stream replaces that note once it starts producing output.

Harness session transcripts live with the Oven's app state, at `~/.config/pillardash/codeinoven/ovens/sessions/<session>.jsonl`, never inside the checkout. A transcript an older release left in the project root as `.cio-pi-<session>.jsonl` is moved into that directory the next time its thread runs, so the session keeps resuming and the working tree stays clean.

Thread rows carry the Oven's own mark and the checkout's branch beside the row's status indicator; a branch longer than four characters is shortened there. The hover card names the Oven, the branch, and the checkout path, and the search results name the Oven and branch too. Switching branches through the remote Changes panel updates the thread's recorded branch.

## Recovery and inventory

Setup operations and progress are persisted without secret values. A setup interrupted by an app restart is marked interrupted; the next run observes remote state before repeating steps. Cancel stops scheduling later commands. A command already running remotely can finish, so its result is checked on retry.

The managed remote probe returns device details, the Oven service's own time zone, and installed harness versions together. Its version scan uses a small worker pool and caches results briefly. Every successful scan is also stored locally, so an unreachable Oven still answers with its last known harness list, and the scan covers every harness CodeInOven knows: a harness the user installs on the Oven themselves appears on the next probe instead of staying invisible. Installed harnesses appear as their own icons in the Oven entry and the Oven picker, with version and health in the tooltip, and the model picker disables a harness the selected Oven does not have installed. Each Oven row keeps **Setup Oven** (or **Update Oven Setup**) and its expand control on the row; the occasional actions, including checking the Oven, matching the clock, and removing the Oven, live in the row's actions menu. **Check Oven** runs the same read-only probe the row draws its details from and reports the result in place, without opening setup and without changing anything on the Oven. The main process caches update metadata for five minutes. When a harness's global auto-update preference is enabled, CodeInOven checks remote ovens shortly after startup and every fifteen minutes. If an Oven probe fails, its update batch is skipped. If SSH becomes unavailable during a harness update, the remaining harnesses on that Oven are skipped for that check; other Ovens still proceed. Harness-specific command failures do not stop the rest of the batch. Updates wait for active runs to finish. Setup installs, manual updates, and uninstalls share a per-oven harness gate that blocks new runs while a change is in progress. Uninstall is a destructive action and must ask for confirmation in the UI.

## Limits

- Setup requires an SSH Oven. Local remains available for harness inventory and normal local use.
- Package operations need root, passwordless `sudo`, or a password-authenticated Oven connection whose login password also authenticates sudo. Setup does not open an interactive password prompt; a privilege refusal is reported as a blocked step.
- The app never performs OS release upgrades or reboots the Oven.
- The Oven clock step and the **Match your time zone** action change only the clock zone. Time, date, and NTP configuration are never touched, and a platform that names zones in its own catalogue (Windows without PowerShell 7) reports that it cannot convert an IANA zone instead of guessing one.
- GitHub SSH is the only managed Git identity provider in this release. Other Git hosts are configured by their own credentials inside the harness, not by this flow.
- Checkouts are prepared from a GitHub remote. A project without one gets an empty prepared directory and is reported as not a Git repository until it is initialized or cloned on the Oven.
- Turn checkpoints (the per-conversation file diffs) track writes this app makes on this computer. An Oven thread's **Changes** tab shows the Oven checkout's own Git state instead.
- Harness commands and versions are discovered from the Oven's executable path. A missing or broken executable is reported separately from an unreachable Oven.
