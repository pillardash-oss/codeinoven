# Windows Package Manager (winget) manifests

Interim distribution path for Windows while the installer is not yet
Authenticode-signed with a Windows-trusted certificate. See
`.cio/work/windows-signing/SIGNING-RUNBOOK.md` for the signing work; this folder
only covers delivery.

`winget install PillardashSolutions.CodeInOven` gives users a Microsoft-run
channel and a single command instead of the browser download flow, which removes
the "isn't commonly downloaded" browser warning that blocks the download today.

## Honest limitation

winget does not make the installer trusted. The executable is still signed with
the macOS Developer ID certificate (see the runbook), so SmartScreen can still
prompt depending on how winget tags the downloaded file with Mark-of-the-Web.
Treat this as a better delivery channel, not a fix. Code signing is the fix.

## Layout

winget requires the folder path to mirror the package identifier exactly:

```
manifests/<first letter>/<publisher>/<package>/<version>/
```

For `PillardashSolutions.CodeInOven` version `0.5.61` that is
`manifests/p/PillardashSolutions/CodeInOven/0.5.61/`, holding the three files:

| File                                               | Purpose                               |
| -------------------------------------------------- | ------------------------------------- |
| `PillardashSolutions.CodeInOven.yaml`              | version manifest                      |
| `PillardashSolutions.CodeInOven.installer.yaml`    | installer URL, hash, install behavior |
| `PillardashSolutions.CodeInOven.locale.en-US.yaml` | publisher, description, links         |

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
named `PillardashSolutions.CodeInOven-<version>`.

1. Fork `microsoft/winget-pkgs` and create the branch.
2. Copy `packaging/winget/manifests/p/PillardashSolutions/CodeInOven/<version>/`
   to the same path inside the fork.
3. On Windows, validate before pushing:
   `winget validate --manifest packaging\winget\manifests\p\PillardashSolutions\CodeInOven\<version>`
4. Open the pull request. The winget-pkgs CI re-validates the manifest, downloads
   the pinned installer, and checks the hash matches.

`wingetcreate` can do steps 1 to 4 automatically and is the faster route once the
package exists:

```powershell
wingetcreate update PillardashSolutions.CodeInOven --version 0.5.61 --urls https://github.com/pillardash-oss/codeinoven/releases/download/v0.5.61/codeinoven-0.5.61-setup.exe --submit
```

## Per-release checklist

- [ ] Run `bun run winget:manifest` after the release is mirrored.
- [ ] Copy the new version folder into a winget-pkgs PR.
- [ ] Validate on Windows with `winget validate`.
- [ ] Confirm the PR's installer hash check passes.
