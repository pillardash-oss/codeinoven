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
bun run msix:check     # validate the identity, build nothing
bun run msix:build     # validate, then build dist/codeinoven-<version>-x64.msix
```

The build only runs on Windows: the appx target shells out to `makeappx.exe` and
`makepri.exe`. Both come from the Windows SDK, and electron-builder fetches a
Windows Kits bundle for them when no local SDK is pointed at by
`ELECTRON_BUILDER_WINDOWS_KITS_PATH`.

In CI the package is built on the Windows leg of a stable release, opt-in through
the repository variable `CODEINOVEN_MSIX_BUILD` (`true` to enable; unset is off).
It is built with `--prepackaged dist/win-unpacked`, so the native launcher, the
fuses and the extra resources are not built a second time. The result is uploaded
as the `codeinoven-msix` workflow artifact.

The MSIX is deliberately **not** attached to the GitHub release and **not**
mirrored to `dl.codeinoven.com`. It is a Store submission rather than a
user-facing download, so it stays out of `SHA256SUMS.txt` and out of the download
mirror's verification path.

## Version numbering

The manifest carries a four-part numeric version. The Store reserves the fourth
part and requires it to be 0 in the package you build, so `scripts/msix.ts`
derives `major.minor.patch.0` from `package.json`.

One rule does not fit a pre-1.0 app. Microsoft requires the other sections to be
"an integer between 0 and 65535 (except for the first section, which cannot be
0)". At version `0.5.61` that produces `0.5.61.0`, whose first section is 0, so
the build prints a warning. If Partner Center rejects the package, the Store
version has to be supplied explicitly, which means overriding
`appx.customManifestPath` with our own manifest instead of using
electron-builder's template.

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
   `electron-builder.yml`.
2. Set the repository variable `CODEINOVEN_MSIX_BUILD` to `true`.
3. Cut a stable release. Download the `codeinoven-msix` artifact from the
   workflow run.
4. Start a new submission in Partner Center, upload the `.msix`, and complete the
   restricted-capability justification, the age rating, the pricing and
   availability and the Store listing.
5. Submit for certification. Partner Center re-validates the package and re-signs
   it with a Microsoft certificate.

If Partner Center insists on a `.msixupload` rather than a `.msix`, note that
`MakeAppx.exe` cannot produce one; it is a zip container that Visual Studio
normally writes. Report it here and that packaging step gets added.
