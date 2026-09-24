# Download mirror (`dl.codeinoven.com`)

GitHub Releases throttles large assets, which makes installer downloads slow. Every
published release is therefore copied to our own Cloudflare R2 origin and served from
`https://dl.codeinoven.com`. Nothing is rebuilt: the job copies exactly the bytes GitHub
already published, after verifying them against the release's own `SHA256SUMS.txt`.

R2 is a cache of the release the channel currently serves, not an archive. Each channel
directory holds one release, and publishing the next release overwrites the same file names and
deletes whatever the channel no longer serves, so the bucket never grows and a download link
never rots. GitHub Releases is the archive: anyone who wants an older version downloads it
there.

Mirrored installers carry **no version in their name** (`stable/codeinoven-arm64.dmg`), because
a channel serves one release. `RELEASE.json` records the GitHub asset name each served file came
from, which is how the app matches a versioned update-feed entry against a versionless mirror
file.

The mirror is used only when it provably holds the same bytes GitHub published: the app
stays on GitHub for update metadata, then compares the `sha512` the mirror publishes for
that file with the `sha512` in GitHub's feed. Equal means download from the mirror;
anything else (a stale mirror, an unreachable mirror, a release that has not been mirrored
yet) means download from GitHub.

| Consumer        | Source                                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Update metadata | GitHub Releases (`latest*.yml`, a few KB)                                                                                                                                    |
| Update bytes    | Mirror once its manifest publishes the feed's `sha512` for that file, else GitHub                                                                                            |
| Manual download | Versionless mirror links (`stable/codeinoven-arm64.dmg`), with the [GitHub release](https://github.com/pillardash-oss/codeinoven/releases) as the archive for older versions |
| Verification    | Mirror manifest `sha512` / `sha256`, or `shasum -a 256 -c SHA256SUMS.txt` against the mirror's own file                                                                      |

## Layout

One directory per channel, served from the bucket root:

```
https://dl.codeinoven.com/stable/    latest-mac.yml, latest.yml, latest-linux.yml
                                     codeinoven-arm64.dmg        macOS
                                     codeinoven-setup.exe        Windows
                                     codeinoven.AppImage | .deb  Linux
                                     SHA256SUMS.txt, RELEASE.json
https://dl.codeinoven.com/nightly/   same names, the newest nightly
```

The file names are the channel's, not the release's: `stable/codeinoven-arm64.dmg` is whatever
`stable` currently serves. Publishing a release overwrites those keys and deletes the objects the
channel no longer serves (the release just replaced, or a leftover from the earlier versioned
layout). Nothing on the mirror is versioned, so nothing here links to an old release.

The mirror carries one installer per platform a user installs from the download page, and
nothing else. GitHub Releases stays the archive, so these stay on GitHub and are **not**
duplicated here:

- the macOS `.zip` is electron-updater's auto-update payload, not a download;
- `.blockmap` files only serve differential downloads, which the app never performs: it
  pre-downloads the whole artifact into electron-updater's pending cache.

Consequence worth knowing: the app's trust check only uses the mirror when its manifest
lists the exact file the update feed points at, and macOS updates download the `.zip`. With
no zip in the bucket, **macOS in-app updates download from GitHub** while Windows and Linux
updates come from the mirror.

Each directory is a self-contained update-feed root: the feed and the artifacts it points at
sit side by side, and both describe the same, single release. Nightly feed assets
(`nightly-mac.yml`, `nightly.yml`, `nightly-linux.yml`) are stored as `latest-*.yml`,
because the channel is the directory. `RELEASE.json` records that mapping in its `feeds`
array.

`SHA256SUMS.txt` is the release's own checksum list rewritten for the names the mirror serves
(the digests are unchanged, and they are verified against the release's file before anything is
uploaded), so `shasum -a 256 -c SHA256SUMS.txt` verifies a versionless download.

`RELEASE.json` is the contract for download pages and for the updater's trust check:

```jsonc
{
  "schemaVersion": 3,
  "channel": "stable",
  "version": "0.5.56", // full version, nightlies included: 0.5.57-nightly.5
  "tag": "v0.5.56",
  "publishedAt": "2026-09-19T12:00:00Z", // GitHub release publication time
  "sourceUrl": "https://github.com/pillardash-oss/codeinoven/releases/tag/v0.5.56",
  "artifacts": [
    {
      "name": "codeinoven-arm64.dmg", // what the mirror serves, no version
      "source": "codeinoven-0.5.56-arm64.dmg", // the GitHub asset it came from
      "platform": "macos", // macos | windows | linux
      "arch": "arm64", // arm64 | x64
      "kind": "dmg", // dmg | installer | appimage | deb (never zip)
      "sizeBytes": 234487204,
      "sha256": "…",
      "sha512": "…", // base64, identical to the value in the channel's update feed
      "url": "https://dl.codeinoven.com/stable/codeinoven-arm64.dmg"
    }
  ],
  "feeds": [{ "source": "latest-mac.yml", "key": "stable/latest-mac.yml" }]
}
```

`sha512` is base64, the same encoding the update feeds use, and it is what the app compares
before it downloads anything from the mirror. `source` is the file name GitHub's feed points at;
`name` and `url` are the versionless mirror file.

## How the app uses it

`src/lib/download-mirror.ts` holds the origin, the URL builders and the trust check.
`src/main/notifications/updater-download.ts` selects the artifact GitHub's feed points at,
fetches the channel's `RELEASE.json`, and offers the mirror only when an entry records that exact
release asset in `source` with the same `sha512` (and size) as the feed. The download URL comes
from that entry's versionless `name`, never from the feed, so the mirror's own file names are the
only thing the app ever requests. The chosen source list is then pre-downloaded into
electron-updater's pending cache, where the bytes are validated against the feed's sha512 before
electron-updater is asked to install it. That pre-download is resumable over HTTP Range requests,
so a dropped connection continues instead of restarting.

Falling back to GitHub is deliberate and automatic:

- the mirror has not been updated for this release, its manifest is unreachable or
  unreadable, or it does not record that release asset (`source`) with the same `sha512` and
  size → GitHub, without a single byte being requested from the mirror;
- mirror returns 404 (a backfilled release that was mirrored before this mechanism, or an
  object deleted mid-run) → GitHub;
- mirror serves bytes that do not match the feed's sha512 → the bytes are discarded and
  GitHub is used;
- mirror never answers → the manifest budget (8 s) plus the artifact response deadline (15 s)
  expire and GitHub is used, so a dead mirror costs seconds, never a stuck update.

Because the check happens before the download, a bucket holding a stale or foreign release
can never serve an update. The worst case for a black-holed origin is about 23 seconds (both
deadlines run one after the other), and only when an update is actually available.

## One-time setup

### 1. R2 bucket and API token

1. Cloudflare dashboard → **R2** → **Create bucket**, e.g. `codeinoven-downloads`
   (location: automatic).
2. **R2 → API → Manage API tokens → Create API token**, permission **Object Read & Write**,
   scoped to that bucket only. Copy the **Access Key ID** and **Secret Access Key**; the
   endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

### 2. Custom domain

Bucket → **Settings → Custom Domains → Connect Domain** → `dl.codeinoven.com`. Cloudflare
creates the DNS record and the certificate. The `r2.dev` endpoint is rate-limited and meant
for development only; serve production traffic through the custom domain.

### 3. Cache rules

Objects are uploaded through the S3 API, which cannot attach `Cache-Control`, so the zone
decides caching. Create two Cache Rules (**Rules → Cache Rules**), in this order:

1. **Feeds stay fresh.** When the hostname is `dl.codeinoven.com` and the path matches
   `*/latest-*.yml`, `*/RELEASE.json` or `*/SHA256SUMS.txt`, bypass cache (or use a very
   short edge TTL). These files change on every release.
2. **Installers are cached briefly.** When the hostname is `dl.codeinoven.com`, mark the
   response cache eligible with the shortest edge TTL Cloudflare allows (one hour) and no
   browser cache. The file names are versionless, so a cached copy can outlive the release it
   was cached for: at most an hour of a manual download still getting the previous installer,
   and never a wrong install from the app, which checks the bytes against GitHub's feed hash
   before it uses them. Bypass cache for the hostname instead if you would rather never serve
   a stale installer; R2 has no egress fees.

Skipping this step still works (objects are served straight from R2), but repeat downloads are
then not edge-cached.

### 3b. Abort incomplete multipart uploads

Artifacts are larger than S3's single-request limit, so each one is a multipart upload. An
upload that is interrupted (a cancelled workflow, a closed laptop, `Ctrl-C`) leaves its parts
behind: the key stays unreadable, because R2 answers 404 for an object that never completed,
but the parts are billed as stored data and the bucket's object list shows the key as a
half-uploaded object. That entry is not a partial download and nothing can download from it.

Every publish aborts the unfinished uploads an earlier run left in the channel it is about to
write, so a backfill or the next release clears them, and it prints what it removed. The
lifecycle rule below is the backstop for a channel that is never published again:

Bucket, **Settings**, **Object lifecycle rules**, **Add rule**: condition **Abort incomplete
multipart uploads**, 1 day after initiation. Finished objects are untouched by this rule.

To see what is waiting, without uploading anything:

```bash
bun run release:mirror --tag v0.5.56 --channel stable --dry-run

# Or straight from the bucket (any S3 client works)
curl -s --aws-sigv4 "aws:amz:auto:s3" --user "$ACCESS_KEY_ID:$SECRET_ACCESS_KEY" \
  "$ENDPOINT/$BUCKET?uploads" | grep -E "<Key>|<Initiated>"
```

### 4. CORS (only for browser-side fetches)

The desktop app downloads from its main process, so it needs no CORS. A website that fetches
`RELEASE.json` from the browser does: bucket → **Settings → CORS Policy**, allow `GET`/`HEAD`
from `https://codeinoven.com` and `https://www.codeinoven.com`.

### 5. GitHub configuration

Repository → **Settings → Secrets and variables → Actions**:

```bash
gh variable set DOWNLOAD_MIRROR_S3_ENDPOINT --body "https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
gh variable set DOWNLOAD_MIRROR_S3_BUCKET --body "codeinoven-downloads"
gh secret set DOWNLOAD_MIRROR_S3_ACCESS_KEY_ID
gh secret set DOWNLOAD_MIRROR_S3_SECRET_ACCESS_KEY
```

`DOWNLOAD_MIRROR_S3_REGION` is optional (default `auto`). Until the two variables exist,
automatic mirror runs are **skipped** instead of failing every release.

## Publishing

`.github/workflows/download-mirror.yml` is dispatched by the release workflows, and can be run
by hand to backfill. It also listens for `release: published`, but that event only fires for a
release published by hand or by a token other than the default one: GitHub does not start a
workflow from an event a `GITHUB_TOKEN` caused, and both `nightly.yml` and `release.yml` publish
their releases with `GITHUB_TOKEN`. Each of them therefore ends by dispatching this workflow,
because `workflow_dispatch` is the documented exception to that rule (it needs `actions: write`
on the token).

```bash
# Mirror an already-published release (workflow_dispatch inputs: tag, channel, keep,
# allow_downgrade, dry_run)
gh workflow run download-mirror.yml -f tag=v0.5.56 -f channel=stable

# Backfill a release older than the one the channel serves (deletes the newer one)
gh workflow run download-mirror.yml -f tag=v0.5.55 -f channel=stable -f allow_downgrade=true

# Same job locally, using your own R2 credentials from .env
bun run release:mirror --tag v0.5.56 --channel stable --dry-run
bun run release:mirror --tag v0.5.56 --channel stable
```

The script (`scripts/publish-release-mirror.ts`):

1. reads the release with `gh` and refuses a channel that contradicts the release's
   prerelease flag;
2. downloads the release assets (or uses `--artifacts-dir`) and **verifies every installer
   against `SHA256SUMS.txt`** before uploading anything: a mismatch aborts the run;
3. aborts any unfinished multipart upload in that channel left by an earlier run, and
   reports what it removed;
4. uploads the mirrored installers under their versionless names, then the feeds, the rewritten
   checksums and `RELEASE.json` last, so a manifest never points at a file that is not there
   yet;
5. reads the first kilobyte of every uploaded key back with a range request and checks the
   size the origin reports for the whole object and the bytes it serves;
6. deletes every installer object the channel holds that this run did not write: the release
   it just replaced (same keys, overwritten) and any leftover from the earlier versioned
   layout (a versioned name, the macOS zip, a blockmap), never touching feeds, checksums or the
   manifest.

Two guards keep the sweep from taking away the release the channel is serving:

- publishing a release _older_ than the one the channel serves is refused before anything is
  uploaded, unless `--allow-downgrade` is passed. The version comes from the channel's own
  `RELEASE.json`, because the mirror's file names no longer carry one (a channel still holding
  the versioned layout is read from its keys);
- after the upload the served version is read again from the manifest: if another run published
  a newer release meanwhile, the sweep is skipped (with a warning) unless `--allow-downgrade`
  was passed. The workflow serializes mirror runs (`concurrency: download-mirror`) so this stays
  a safety net.

Upload the release from CI, not from a laptop. A release is about 750 MB, so a home uplink
turns that into an hour-long job (measured 0.12 MiB/s up on a constrained connection), while
the GitHub runner that published the release finishes it in a minute or two. A local run is
for backfills on a fast connection, and for `--dry-run`, which needs no credentials and
uploads nothing.

## Downloading from the terminal

Every link is versionless, so the same command works until you decide to upgrade:

```bash
curl -fL -O https://dl.codeinoven.com/stable/codeinoven-arm64.dmg   # macOS (Apple silicon)
curl -fL -O https://dl.codeinoven.com/stable/codeinoven.AppImage     # Linux
curl -fL -O https://dl.codeinoven.com/stable/codeinoven.deb          # Debian / Ubuntu
curl -fL -O https://dl.codeinoven.com/stable/codeinoven-setup.exe    # Windows
```

Then verify, in the directory you downloaded into:

```bash
curl -fLO https://dl.codeinoven.com/stable/SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

`RELEASE.json` lists the same files with `platform`, `arch`, `kind` and `sizeBytes`, so a script
can pick the right one for the machine it runs on:

```bash
curl -fsS https://dl.codeinoven.com/stable/RELEASE.json | jq -r '.artifacts[] | "\(.kind)\t\(.url)"'
```

## Verifying a mirror

```bash
curl -fsS https://dl.codeinoven.com/stable/RELEASE.json | jq '{version, artifacts: [.artifacts[].name]}'
curl -sI https://dl.codeinoven.com/stable/RELEASE.json | grep -i 'cf-cache-status\|cache-control'
# Range requests (what the resumable updater uses) must answer 206:
curl -s -o /dev/null -w '%{http_code}\n' -r 0-1023 \
  "https://dl.codeinoven.com/stable/$(curl -fsS https://dl.codeinoven.com/stable/RELEASE.json | jq -r '.artifacts[0].name')"
```

A note for anyone scripting checks against R2: a `HEAD` is not a reliable way to read an
object's size here. Cloudflare compresses `text/plain` and `application/json` responses, so a
HEAD of `SHA256SUMS.txt` or `RELEASE.json` comes back with `content-encoding: gzip` and **no**
`content-length` (Bun's `S3File.stat()` reports 0 for exactly those two, which is why the
publish script reads objects back with `Range: bytes=0-1023` and takes the total from
`content-range`). A range request answers 206 uncompressed, so it works for every content type.

An installer URL downloaded from the mirror must hash to the `sha256` in `RELEASE.json`. To
confirm the mirror is currently trustworthy for an installed app, compare its `sha512` with
the one GitHub's feed publishes for the same release asset (the mirror entry's `source`):

```bash
manifest=$(curl -fsS https://dl.codeinoven.com/stable/RELEASE.json)
source_name=$(printf '%s' "$manifest" | jq -r '.artifacts[] | select(.kind == "zip") | .source // .artifacts[0].source')
mirror_sha=$(printf '%s' "$manifest" | jq -r --arg f "$source_name" '.artifacts[] | select(.source == $f) | .sha512')
github_sha=$(curl -fsS https://github.com/pillardash-oss/codeinoven/releases/latest/download/latest-mac.yml | \
  awk -v f="$source_name" '$0 ~ "url: " f {found=1} found && /sha512:/ {print $2; exit}')
[ "$mirror_sha" = "$github_sha" ] && echo "mirror is trusted for $source_name" || echo "app would use GitHub"
```

Equal values mean the next update download comes from `dl.codeinoven.com`. Different values
mean the app silently uses GitHub instead; re-run the mirror job for that release.

## Retention and cost

A full release is ~750 MB across the four mirrored installers (measured on the `v0.5.56`
assets: dmg 223.6, exe 164.5, AppImage 202.3, deb 156.4). Each channel holds exactly the release
it serves, so the bucket stays at ~750 MB per channel (~1.5 GB for both) and does not grow:
versionless keys mean the next release overwrites the previous one, and the sweep deletes
whatever the channel no longer serves. R2 storage is
$0.015/GB-month with no egress fees
([R2 pricing](https://developers.cloudflare.com/r2/pricing/)), so the whole mirror costs
cents per month. `--keep 0` disables deletion if you ever want the bucket to accumulate.

Deletion is safe because the app never asks the mirror for anything but the version its
GitHub feed points at, and the hash check refuses anything else. A release that is not in
the bucket at all (never mirrored, deleted by the sweep, or published while the mirror job
was skipped) is served from GitHub. A user who wants an older version than the one the channel
serves downloads it from GitHub Releases, which keeps every release and every asset.

## Disabling the mirror

- Stop mirroring: delete (or empty) the two repository variables. The workflow job is
  skipped, releases keep publishing to GitHub, and the app falls back to GitHub on its own.
- Remove the mirror from the app: change `DOWNLOAD_MIRROR_URL` in
  `src/lib/download-mirror.ts`. That ships with the next release; until then already-installed
  apps keep trying the mirror first and fall back to GitHub within seconds.
