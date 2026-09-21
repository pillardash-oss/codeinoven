# Download mirror (`dl.codeinoven.com`)

GitHub Releases throttles large assets, which makes installer downloads slow. Every
published release is therefore copied to our own Cloudflare R2 origin and served from
`https://dl.codeinoven.com`. Nothing is rebuilt: the job copies exactly the bytes GitHub
already published, after verifying them against the release's own `SHA256SUMS.txt`.

GitHub Releases stays the feed and the fallback, so the mirror can never break a download:

| Consumer            | Source                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Update metadata     | GitHub Releases (`latest*.yml`, a few KB)                                                  |
| Update bytes        | Mirror first, GitHub when the mirror is unreachable or lacks the file                       |
| Manual download     | Mirror links, with the [GitHub release](https://github.com/pillardash-oss/codeinoven/releases) as the archive |
| Verification        | sha512 from the update feed; `SHA256SUMS.txt` and `RELEASE.json` per channel                |

## Layout

One directory per channel, served from the bucket root:

```
https://dl.codeinoven.com/stable/    latest-mac.yml, latest.yml, latest-linux.yml
                                     codeinoven-<version>-arm64.zip | .dmg | -setup.exe
                                     codeinoven-<version>.AppImage | .deb, *.blockmap
                                     SHA256SUMS.txt, RELEASE.json
https://dl.codeinoven.com/nightly/   same shape, nightly versions
```

Each directory is a self-contained update-feed root: the feed and the artifacts it points at
sit side by side. Nightly feed assets (`nightly-mac.yml`, `nightly.yml`, `nightly-linux.yml`)
are stored as `latest-*.yml`, because the channel is the directory. `RELEASE.json` records
that mapping in its `feeds` array.

`RELEASE.json` is the contract for download pages:

```jsonc
{
  "schemaVersion": 1,
  "channel": "stable",
  "version": "0.5.56", // full version, nightlies included: 0.5.57-nightly.5
  "tag": "v0.5.56",
  "publishedAt": "2026-09-19T12:00:00Z", // GitHub release publication time
  "sourceUrl": "https://github.com/pillardash-oss/codeinoven/releases/tag/v0.5.56",
  "artifacts": [
    {
      "name": "codeinoven-0.5.56-arm64.dmg",
      "platform": "macos", // macos | windows | linux
      "arch": "arm64", // arm64 | x64
      "kind": "dmg", // dmg | zip | installer | appimage | deb
      "sizeBytes": 234487204,
      "sha256": "…",
      "url": "https://dl.codeinoven.com/stable/codeinoven-0.5.56-arm64.dmg"
    }
  ],
  "feeds": [{ "source": "latest-mac.yml", "key": "stable/latest-mac.yml" }]
}
```

## How the app uses it

`src/lib/download-mirror.ts` holds the origin and the URL builders.
`src/main/notifications/updater-download.ts` builds the ordered sources (mirror, then
GitHub) and pre-downloads the update into electron-updater's pending cache, where it is
validated against the feed's sha512 before electron-updater is asked to install it. That
pre-download is resumable over HTTP Range requests, so a dropped connection continues
instead of restarting.

Fallback is deliberate and automatic:

- mirror returns 404 (an older release that has been pruned, or one mirrored before this
  mechanism existed) → GitHub;
- mirror serves bytes that do not match the feed's sha512 → the bytes are discarded and
  GitHub is used;
- mirror never answers → the response deadline (15 s) fires and GitHub is used, so a dead
  mirror costs a few seconds, never a stuck update.

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

1. **Feeds stay fresh** — when the hostname is `dl.codeinoven.com` and the path matches
   `*/latest-*.yml`, `*/RELEASE.json` or `*/SHA256SUMS.txt`: bypass cache (or a very short
   edge TTL). These files change on every release.
2. **Artifacts are immutable** — when the hostname is `dl.codeinoven.com`: cache eligible,
   edge TTL one year, browser TTL one year. Artifact names embed the version, so a cached
   copy is never stale.

Skipping this step still works (objects are served straight from R2, which has no egress
fees), but downloads are then not edge-cached.

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

`.github/workflows/download-mirror.yml` runs automatically when a release is published
(stable and nightly), and can be run by hand to backfill:

```bash
# Mirror an already-published release (workflow_dispatch inputs: tag, channel, keep, dry_run)
gh workflow run download-mirror.yml -f tag=v0.5.56 -f channel=stable

# Same job locally, using your own R2 credentials from .env
bun run release:mirror --tag v0.5.56 --channel stable --dry-run
bun run release:mirror --tag v0.5.56 --channel stable
```

The script (`scripts/publish-release-mirror.ts`):

1. reads the release with `gh` and refuses a channel that contradicts the release's
   prerelease flag;
2. downloads the release assets (or uses `--artifacts-dir`) and **verifies every installer
   against `SHA256SUMS.txt`** — a mismatch aborts before anything is uploaded;
3. uploads installers and blockmaps, then feeds, checksums and `RELEASE.json` last, so a
   feed never points at a file that is not there yet;
4. HEAD-verifies every uploaded key's size against the local file;
5. prunes releases older than `--keep` (default 3) per channel, never touching feeds,
   checksums or the manifest.

## Verifying a mirror

```bash
curl -fsS https://dl.codeinoven.com/stable/RELEASE.json | jq '{version, artifacts: [.artifacts[].name]}'
curl -sI https://dl.codeinoven.com/stable/RELEASE.json | grep -i 'cf-cache-status\|cache-control'
# Range requests (what the resumable updater uses) must answer 206:
curl -s -o /dev/null -w '%{http_code}\n' -r 0-1023 \
  "https://dl.codeinoven.com/stable/$(curl -fsS https://dl.codeinoven.com/stable/RELEASE.json | jq -r '.artifacts[0].name')"
```

An installer URL downloaded from the mirror must hash to the `sha256` in `RELEASE.json`.

## Retention and cost

A full release is ~970 MB across the five installers plus a few MB of blockmaps
(measured on the `v0.5.56` assets). With the default `--keep 3`, each channel holds about
3 GB. R2 storage is $0.015/GB-month with no egress fees
([R2 pricing](https://developers.cloudflare.com/r2/pricing/)), so both channels together cost
well under $1/month. Raise or lower retention with `--keep` (0 keeps everything).

Pruning is safe: the app only ever downloads the version its update feed points at, and an
older version that has been pruned falls back to GitHub.

## Disabling the mirror

- Stop mirroring: delete (or empty) the two repository variables. The workflow job is
  skipped, releases keep publishing to GitHub, and the app falls back to GitHub on its own.
- Remove the mirror from the app: change `DOWNLOAD_MIRROR_URL` in
  `src/lib/download-mirror.ts`. That ships with the next release; until then already-installed
  apps keep trying the mirror first and fall back to GitHub within seconds.
