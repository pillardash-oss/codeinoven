# Microsoft Store (MSIX) package

The Store channel for Windows. It exists because the Store signs MSIX packages
with a Microsoft certificate, which is what gives Windows a publisher identity
without us buying a Windows code-signing certificate.

The NSIS installer stays. It is still what winget and the direct download offer,
and it is what carries the Explorer context-menu verbs. This folder covers the
Store package only; see `.cio/work/windows-signing/SIGNING-RUNBOOK.md` for the
code-signing work on the installer.

## Why not the Store's EXE/MSI flow

Microsoft's EXE/MSI submission requires "the binary and all of its Portable
Executable (PE) files" to be "digitally signed with a code signing certificate
that chains up to a certificate issued by a CA that is part of the Microsoft
Trusted Root Program". Our installer is signed with the Apple Developer ID
certificate, so it does not qualify, and the EXE flow does not make Windows trust
it. Only MSIX gets Store signing, so only MSIX actually removes the SmartScreen
and Defender warning.

## Before the first build

Two values come from Partner Center and cannot be guessed. Reserve the app name
first, then open **Product management > Product identity** and copy:

| Partner Center field                      | Where it goes                                 |
| ----------------------------------------- | --------------------------------------------- |
| `Package/Identity/Name`                   | `appx.identityName` in `electron-builder.yml` |
| `Package/Identity/Publisher`              | `appx.publisher` in `electron-builder.yml`    |
| `Package/Properties/PublisherDisplayName` | `appx.publisherDisplayName` (already set)     |

Paste them byte for byte. Microsoft's requirements are explicit that the manifest
values are case sensitive and that "spaces and other punctuation must also
match". `bun run msix:check` fails while either value is still a placeholder,
which is deliberate: electron-builder silently substitutes `CN=ms` for a missing
publisher on an unsigned appx build and falls back to the `package.json` name for
a missing identity name, so a wrong identity would otherwise only surface when
certification rejects the package.

## Building

```sh
bun run msix:check     # validate the identity and print the package version
bun run msix:build     # validate, build dist/codeinoven-<package-version>-x64.msix, then verify it
```

Every build is verified before it is reported as built. An MSIX is a zip
container, so `scripts/msix.ts` reads `AppxManifest.xml` straight out of the
package it just produced and asserts the identity the Store matches byte for
byte, the version rules below, and that the executable and the tile assets the
manifest names are actually inside the package. That check is not ceremony: the
appx target is the one build step that cannot run on a developer machine, so
the manifest is the part most likely to be wrong, and reading the artifact back
is the only way to see it. `bun scripts/msix.ts --verify-only <file.msix>`
re-runs the same check on a package built elsewhere, including one downloaded
from CI.

The build only runs on Windows: the appx target shells out to `makeappx.exe` and
`makepri.exe`. Both come from the Windows SDK, and electron-builder fetches a
Windows Kits bundle for them when no local SDK is pointed at by
`ELECTRON_BUILDER_WINDOWS_KITS_PATH`.

## Where the package is built

Two paths produce it, both on Windows:

- **On demand**, for a submission: run the **Microsoft Store package** workflow
  (`.github/workflows/msix.yml`) from the Actions tab, or
  `gh workflow run msix.yml`. It builds the Windows app unsigned, builds and
  verifies the MSIX, and uploads it as the `codeinoven-msix` artifact. This is
  the path to use for a first submission and for every re-submission after a
  certification failure, because it needs no public release.
- **On a stable release**: the Windows leg of the release workflow builds the
  same package when the repository variable `CODEINOVEN_MSIX_BUILD` is `true`,
  from the app directory the ordinary packaging step already produced
  (`--prepackaged dist/win-unpacked`), so the native launcher, the fuses and the
  extra resources are not built a second time. That is how a release and its
  Store package stay the same code.

Neither path signs anything: the Store re-signs the package with a Microsoft
certificate during certification, so the Authenticode certificate the NSIS
installer needs is irrelevant here (see `.cio/work/windows-signing/SIGNING-RUNBOOK.md`).

The MSIX is deliberately **not** attached to the GitHub release and **not**
mirrored to `dl.codeinoven.com`. It is a Store submission rather than a
user-facing download, so it stays out of `SHA256SUMS.txt` and out of the download
mirror's verification path.

## Version numbering

The manifest carries a four-part numeric version. The Store reserves the fourth
part and requires it to be 0 in the package we build, and it does not allow the
first part to be 0 either: "the other sections must be set to an integer between
0 and 65535 (except for the first section, which cannot be 0)"
([app package requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)).

This app is pre-1.0, so its own version cannot be used verbatim: `0.5.65` would
become `0.5.65.0` and be rejected. `scripts/msix.ts` therefore maps the app
version by adding one to the major part, and injects the result as
`-c.extraMetadata.version` for this build only, so `package.json` keeps the real
version:

| App version (`package.json`) | Store package version |
| ---------------------------- | --------------------- |
| `0.5.65`                     | `1.5.65.0`            |
| `0.6.0`                      | `1.6.0.0`             |
| `1.0.0`                      | `2.0.0.0`             |

The constant offset is deliberate. The Store hands each device the highest
applicable version, so a mapping that mapped a 0 major to 1 and left the rest
alone would drop from `1.5.x` to `1.0.x` at the 1.0 release and stop updating
everyone who installed the app before 1.0. With the offset, a higher app version
is always a higher package version, and no submission ever has to be renumbered
by hand.

## Runtime behaviour under package identity

`process.windowsStore` is true inside the package, and two things change:

- **AppUserModelID.** Windows derives the AUMID from the package and attributes
  toasts and taskbar pinning to whatever the process claims, so
  `app.setAppUserModelId` is skipped and the OS-provided identity is left alone
  (`src/main/index.ts`).
- **Self-update.** The package directory is read-only, so the NSIS payload
  electron-updater would hand to the platform installer has nowhere to install,
  and the Store owns delivery once a package has identity. `canAutoUpdate` is
  false for a packaged launch (`src/main/notifications/updater-service.ts`), which
  disables the periodic timer, the explicit check, the tray entry, the updater
  IPC and the fatal-recovery path in one place.

Everything else already survives a read-only install directory: all app state
lives under `~/.config/pillardash/codeinoven` (`src/lib/utils.ts`). The one
exception is the Windows launcher's `.startup.log`, which it writes beside its own
executable (`scripts/native-splash/native/launcher.cpp`); there the create fails
and the launcher continues without it.

## Known gaps

- **No Explorer context menus.** "Open in CodeInOven" for folders, folder
  backgrounds and arbitrary files is a registry verb written by the NSIS installer
  (`build/installer.nsh`). The MSIX equivalent for those three locations needs a
  native COM `IExplorerCommand` handler registered as a `com:SurrogateServer`,
  which an all-JavaScript app cannot supply. The Store build installs without
  them; the NSIS install keeps them.
- **English only.** There is no i18n layer in this app, so the package declares
  `en-US`. Adding languages means translating the app first.
- **Updates come from the Store.** The in-app updater is disabled inside the
  package, so a Store release reaches users when the next package passes
  certification. That is a different cadence from the NSIS channel, which still
  self-updates from the mirror.
- **`runFullTrust` is a restricted capability.** The Store submission asks for a
  written justification. A full-trust desktop app cannot work without it.

## Submitting

1. Reserve the app name in Partner Center and paste the two identity values into
   `electron-builder.yml`. `bun run msix:check` prints the package version the
   build will carry, and fails while either value is still a placeholder.
2. Build the package: `gh workflow run msix.yml`, or set the repository variable
   `CODEINOVEN_MSIX_BUILD` to `true` and cut a stable release. Download the
   `codeinoven-msix` artifact, and run `bun scripts/msix.ts --verify-only` on it
   if it was built somewhere other than this machine.
3. Start a new submission in Partner Center, upload the `.msix`, and fill the
   remaining sections from `packaging/msix/store-listing.md`, which is the
   field-by-field sheet: category, pricing, description, features, keywords,
   support and legal URLs, age rating answers and the `runFullTrust`
   justification. The screenshots are in `packaging/msix/store-assets/`.
4. Publish `packaging/msix/privacy-policy.md` at the URL the submission declares
   and set that URL in `store-listing.md` first. A submission cannot pass
   certification with a privacy policy URL that does not resolve.
5. Submit for certification. Partner Center re-validates the package and
   re-signs it with a Microsoft certificate.

That is the first submission only. Everything after it is automatic; see the
next section.

## Updating the Store on every stable release

A Store-installed copy cannot update itself: the package directory is read-only
and the Store owns delivery, so `canAutoUpdate` is false under package identity
(`src/main/notifications/updater-service.ts`). Nothing else in the release
pipeline reaches those users, which means an unsubmitted package means they
never receive the release at all.

So the stable release path submits for us. `.github/workflows/release.yml` has a
`store` job that runs after the GitHub release is published, downloads the
`codeinoven-msix` artifact the Windows leg already built and verified, and runs
`scripts/store-submission.ts`, which drives the Microsoft Store Submission API:
create a submission from the last one, upload the package, commit, poll. Because
it copies the previous submission, the listing copy, age ratings and pricing
carry over, and only the package changes.

It is off until three secrets and two variables exist:

| Name                     | Kind     | Where it comes from                                  |
| ------------------------ | -------- | ---------------------------------------------------- |
| `STORE_TENANT_ID`        | secret   | Azure AD tenant that owns the Partner Center account |
| `STORE_CLIENT_ID`        | secret   | Azure AD application (client) id                     |
| `STORE_CLIENT_SECRET`    | secret   | that application's client secret                     |
| `STORE_APP_ID`           | variable | `9NC20ZH8DFCN`, the product's Store ID               |
| `CODEINOVEN_MSIX_SUBMIT` | variable | `true` to switch the job on                          |

Creating the Azure AD application is the part only the account owner can do: in
the Azure portal, register an app in the same tenant as the Partner Center
account, add the **Windows Store Submission API** permission from the Microsoft
Store Developer Center API and grant admin consent, then create a client secret
and set the three secrets above with `gh secret set`. The tenant administrator
permission this needs is why it is not scripted here.

Two constraints come from the API rather than from this repository. It cannot
create the first submission, because it copies an existing one that already has
age ratings, which is why the manual steps above come first. And it must own the
submission it works on: editing that submission in Partner Center afterwards
leaves it in a state the API can no longer commit, so once this is switched on,
change submissions through the pipeline.

`bun scripts/store-submission.ts --dry-run` authenticates and reports the last
submission without changing anything, which is the way to check the credentials
before a release depends on them.

### Rotating the Store credentials

Only the client secret expires; the tenant and client id are stable, and the
Partner Center association is by client id, so a secret rotation touches one
secret and nothing else.

1. Entra admin center, **App registrations**, the Store submission app,
   **Certificates & secrets**, **New client secret**. Note the expiry.
2. `gh secret set STORE_CLIENT_SECRET` and paste the new value. The old secret
   keeps working until it expires, so both are valid for a moment and no release
   can fail in between.
3. Delete the old secret in the same blade once the next stable release has
   submitted successfully.

Rotating the client id is a bigger change: register a new app (or rotate the
application), grant the Windows Store Submission API permission with admin
consent, replace the **Azure AD application** entry in Partner Center, then
`gh secret set STORE_CLIENT_ID`. Do it in that order so the account never points
at an app that cannot submit.

The secret is rebuilt by nobody automatically. A 12 month lifetime with a
calendar reminder beats a 24 month one that nobody remembers; the failure mode
when it expires is a release whose Store job cannot authenticate, which is loud
and harmless because the GitHub release and every other channel already shipped.

If Partner Center insists on a `.msixupload` rather than a `.msix`, note that
`MakeAppx.exe` cannot produce one; it is a zip container that Visual Studio
normally writes. Report it here and that packaging step gets added.

## Store listing assets

The package's own tiles are in `build/appx` and are rendered by
`scripts/build-app-icons.ts`. The listing screenshots are separate and live in
`packaging/msix/store-assets/`:

| File                         | Shows                                              |
| ---------------------------- | -------------------------------------------------- |
| `screenshot-1-workspace.png` | the thread list, the composer and a project canvas |

Each is 1920x1080, which is the size the Store asks for. They are frames of this
app running as a desktop build, cropped from the launch-video assets in the
website repository to remove the macOS window chrome and letterboxing, so they
show the application rather than the host OS. Recapture them for the platform
being submitted if Windows-specific chrome matters, and add up to ten: the Store
requires at least one and the listing is stronger with three or four.
