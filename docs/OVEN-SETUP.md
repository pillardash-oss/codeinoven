# Remote Oven setup

Oven setup prepares an SSH Oven for CodeInOven runs. It does not perform full setup or package upgrades on the Local Oven. Setup supports Linux, macOS, and native Windows on x64 and arm64. The remote service requires Node.js 22 or later.

## Run setup

1. Add and test the SSH Oven in Settings → Ovens.
2. Open **Setup**. The app reads the OS, architecture, package manager, privilege, Git, curl, Node.js, npm, reboot state, and installed harness inventory without changing the host.
3. Choose harnesses and optional GitHub identity settings. Saved accounts and portable configuration for selected harnesses synchronize automatically. Choose the account to use when sending a message.
4. Select **Start setup** to authorize package upgrades and the selected installs. Package registry refresh and package upgrades run before Node bootstrap. OS release upgrades and reboots are never automatic.
5. Follow progress in the global docked setup panel. Leaving Settings or switching views keeps the panel and progress tracking alive. Failed steps include their error. Retry rechecks completed steps and resumes work that still needs attention.

Linux system package commands run directly as root or through noninteractive sudo for other users, including passwordless-sudo users. Remote command failures are reported separately from SSH connection and trust errors.

Package updates use the detected package manager: apt, dnf, yum, pacman, Homebrew, winget, Chocolatey, or Scoop. Harness installs use the same documented channel metadata as the Local installer. A selected harness without a supported one-command install path blocks setup rather than running a guessed command.

## Accounts and GitHub

Account credentials are stored in the local encrypted vault. Setup sends selected credentials over the authenticated SSH connection and writes them into the Oven account directory with owner-only permissions. Portable settings are copied automatically alongside saved accounts for the selected harnesses. Transcripts, caches, and local account homes are not copied.

Git setup uses a dedicated key for the Oven, separate from the SSH key used to log in. The private key travels from the encrypted vault through SSH input, never through command arguments or progress records. Use an unencrypted dedicated key, or load an encrypted key into the Oven's own `ssh-agent` before setup. CodeInOven does not send key passphrases to the Oven. The Oven writes the key under its own `.ssh` directory with restrictive permissions. GitHub verification requires strict host-key checking. If `github.com` is not in the Oven's `known_hosts`, compare its fingerprint with the published values shown by CodeInOven and add it on the Oven before retrying. CodeInOven does not accept a host key automatically.

## Recovery and inventory

Setup operations and progress are persisted without secret values. A setup interrupted by an app restart is marked interrupted; the next run observes remote state before repeating steps. Cancel stops scheduling later commands. A command already running remotely can finish, so its result is checked on retry.

The managed remote probe returns device details and installed harness versions together. Its version scan uses a small worker pool and caches results briefly. The main process caches update metadata for five minutes. When a harness's global auto-update preference is enabled, CodeInOven checks remote ovens shortly after startup and every fifteen minutes. If an Oven probe fails, its update batch is skipped. If SSH becomes unavailable during a harness update, the remaining harnesses on that Oven are skipped for that check; other Ovens still proceed. Harness-specific command failures do not stop the rest of the batch. Updates wait for active runs to finish. Setup installs, manual updates, and uninstalls share a per-oven harness gate that blocks new runs while a change is in progress. Uninstall is a destructive action and must ask for confirmation in the UI.

## Limits

- Setup requires an SSH Oven. Local remains available for harness inventory and normal local use.
- Package operations may need root or passwordless `sudo`. Setup does not prompt for a remote password; a privilege refusal is reported as a blocked step.
- The app never performs OS release upgrades or reboots the Oven.
- GitHub SSH is the only managed Git identity provider in this release. Other Git hosts are not configured by this flow.
- Harness commands and versions are discovered from the Oven's executable path. A missing or broken executable is reported separately from an unreachable Oven.
