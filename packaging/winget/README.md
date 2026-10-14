# Windows Package Manager (winget) manifests

Interim distribution path for Windows while the installer is not yet
Authenticode-signed with a Windows-trusted certificate. See
`.cio/work/windows-signing/SIGNING-RUNBOOK.md` for the signing work; this folder
only covers delivery.

`winget install com.pillardash.codeinoven` gives users a Microsoft-run channel
and a single command instead of the browser download flow, which removes the
"isn't commonly downloaded" browser warning that blocks the download today.

## One identifier across platforms

The identifier is `com.pillardash.codeinoven` everywhere the app has an
OS-level identity, so a user, an installer, or an uninstall entry sees the same
string on every platform:

| Surface                    | Value                       | Source                         |
| -------------------------- | --------------------------- | ------------------------------ |
| electron-builder `appId`   | `com.pillardash.codeinoven` | `electron-builder.yml`         |
| macOS `CFBundleIdentifier` | `com.pillardash.codeinoven` | `APP_ID` in `src/lib/brand.ts` |
| Windows AppUserModelID     | `com.pillardash.codeinoven` | `src/main/index.ts`            |
| Windows install GUID       | derived UUIDv5 of the appId | electron-builder NSIS target   |
| winget `PackageIdentifier` | `com.pillardash.codeinoven` | this folder                    |

winget's schema accepts a dotted identifier (up to 8 segments, each up to 32
characters), and reverse-DNS entries already exist in the community repository,
for example `io.github.frathe.picfetch`, so this is a supported form rather than
a workaround.

Two identities deliberately do **not** use the reverse-DNS string, because they
are owned by someone other than us:

- The Windows code-signing publisher is the legal entity that owns the
  certificate (`Pillardash Solutions Limited`). Authenticode subjects carry a
  legal name, and SmartScreen reputation is keyed off that subject, never off
  any identifier we choose.
- A Microsoft Store package identity, if we ever publish there, is assigned by
  Partner Center.

A winget identifier is permanent: once a version is merged it becomes the
upgrade key, so changing it later ships a second package instead of an upgrade.
Decide the string before the first submission.

## Honest limitation

winget does not make the installer trusted. The executable is still signed with
the macOS Developer ID certificate (see the runbook), so SmartScreen can still
prompt depending on how winget tags the downloaded file with Mark-of-the-Web.
Treat this as a better delivery channel, not a fix. Code signing is the fix.

## Layout

winget requires the folder path to mirror the package identifier exactly: the
first folder is the lowercase first letter, then every dotted segment,
case-sensitive.

```
manifests/<first letter>/<identifier segments>/<version>/
```

For `com.pillardash.codeinoven` version `0.5.61` that is
`manifests/c/com/pillardash/codeinoven/0.5.61/`, holding the three files:

| File                                          | Purpose                               |
| --------------------------------------------- | ------------------------------------- |
| `com.pillardash.codeinoven.yaml`              | version manifest                      |
| `com.pillardash.codeinoven.installer.yaml`    | installer URL, hash, install behavior |
| `com.pillardash.codeinoven.locale.en-US.yaml` | publisher, description, links         |

The installer manifest pins the versioned GitHub asset
(`codeinoven-<version>-setup.exe`), never the versionless mirror link, because
winget pins one immutable hash per version and the mirror overwrites its file
names every release.

## Regenerating for a release

The hash and asset name come from the release mirror's own `RELEASE.json`, so the
manifest cannot drift from the published bytes:

```sh
bun run winget:manifest
```

To regenerate offline, or to target a release that is not yet mirrored, pass the
values explicitly:

```sh
bun scripts/winget-manifest.ts --version 0.5.62 --sha256 <hex> --date 2026-11-01
```

`--channel`, `--url`, and `--out` are also accepted.

## Submitting to winget

The manifests ship in a pull request to
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs), on a branch
named `com.pillardash.codeinoven-<version>`.

1. Fork `microsoft/winget-pkgs` and create the branch.
2. Copy `packaging/winget/manifests/c/com/pillardash/codeinoven/<version>/`
   to the same path inside the fork.
3. On Windows, validate before pushing:
   `winget validate --manifest packaging\winget\manifests\c\com\pillardash\codeinoven\<version>`
4. Open the pull request. The winget-pkgs CI re-validates the manifest, downloads
   the pinned installer, and checks the hash matches.

`wingetcreate` can do steps 1 to 4 automatically and is the faster route once the
package exists:

```powershell
wingetcreate update com.pillardash.codeinoven --version 0.5.61 --urls https://github.com/pillardash-oss/codeinoven/releases/download/v0.5.61/codeinoven-0.5.61-setup.exe --submit
```

## Per-release checklist

- [ ] Run `bun run winget:manifest` after the release is mirrored.
- [ ] Copy the new version folder into a winget-pkgs PR.
- [ ] Validate on Windows with `winget validate`.
- [ ] Confirm the PR's installer hash check passes.
