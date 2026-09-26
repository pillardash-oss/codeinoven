# Secrets & Environment Variables Guide

Where every secret lives, where to get it, and where to put it. Work top to
bottom before your first release. Never commit any of these values to the
repository.

The CodeInOven desktop app has no server component   it is distributed through
GitHub Releases, mirrored to `dl.codeinoven.com` for fast downloads, and
self-updates via the built-in auto-updater. The only secrets it needs are the
ones below (signing + CI). The marketing website's secrets live in the
`pillardash-oss/codeinoven-site` repository.

---

## 1. GitHub Actions secrets   release signing (required for the `release.yml` / `nightly.yml` workflows)

These are stored in **GitHub → repo → Settings → Secrets and variables → Actions**
for `pillardash-oss/codeinoven`.

| Secret name | What it is | Where to get it |
| ----------- | ---------- | --------------- |
| `CSC_LINK` | Base64 of your Apple Developer ID Application certificate (`.p12` or `.pfx`), used by electron-builder to sign the macOS binary. | Export from **Keychain Access** → your "Developer ID Application" certificate → right-click → *Export* → `.p12`, then `base64 <cert.p12>`. |
| `CSC_KEY_PASSWORD` | Password you set when exporting the `.p12`. | You set it during the `.p12` export in Keychain Access. |
| `APPLE_ID` | Apple ID email for notarization. | Your Apple ID (the email you use for the Apple Developer account). |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization (not your Apple ID password). | [appleid.apple.com](https://appleid.apple.com) → Sign-In & Security → App-Specific Passwords → generate one. |
| `APPLE_TEAM_ID` | Your Apple Developer team ID. | [developer.apple.com](https://developer.apple.com/account) → Membership Details → Team ID (10-char, e.g. `KU8UFSTCN5`). |
| `GITLEAKS_LICENSE` | Free Gitleaks license key (required because the repo belongs to an organization). | [gitleaks.io](https://gitleaks.io) → sign up → license emailed to you. |

**How to set:** in the GitHub UI, or:

```bash
gh secret set CSC_LINK --repo pillardash-oss/codeinoven
gh secret set CSC_KEY_PASSWORD --repo pillardash-oss/codeinoven
gh secret set APPLE_ID --repo pillardash-oss/codeinoven
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo pillardash-oss/codeinoven
gh secret set APPLE_TEAM_ID --repo pillardash-oss/codeinoven
gh secret set GITLEAKS_LICENSE --repo pillardash-oss/codeinoven
```

> **Windows/Linux note:** `CSC_LINK`/`CSC_KEY_PASSWORD` also sign the Windows
> executable. The CI already skips signing when `CSC_LINK` is empty, so a
> missing secret produces unsigned artifacts instead of failing.

### Download mirror   release artifacts (`dl.codeinoven.com`)

After a release is published, `.github/workflows/download-mirror.yml` copies the same
verified artifacts to our own Cloudflare R2 origin so users stop downloading installers, and
the app stops downloading the macOS auto-update payload, from GitHub Releases. The endpoint
and bucket are repository **variables**; the credentials are **secrets**. Full setup (bucket,
custom domain, cache rules): `docs/DOWNLOAD-MIRROR.md`.

| Name | Kind | What it is | Where to get it |
| ---- | ---- | ---------- | --------------- |
| `DOWNLOAD_MIRROR_S3_ENDPOINT` | variable | S3 endpoint of the R2 account, `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. | Cloudflare dashboard → **R2 → API**. |
| `DOWNLOAD_MIRROR_S3_BUCKET` | variable | Bucket that serves `dl.codeinoven.com`, e.g. `codeinoven-downloads`. | The bucket you created. |
| `DOWNLOAD_MIRROR_S3_REGION` | variable (optional) | Region string; default `auto`, which is what R2 expects. |   |
| `DOWNLOAD_MIRROR_S3_ACCESS_KEY_ID` | secret | Access Key ID of an R2 API token with **Object Read & Write** on that bucket only. | **R2 → API → Manage API tokens → Create API token**. |
| `DOWNLOAD_MIRROR_S3_SECRET_ACCESS_KEY` | secret | Secret Access Key of the same token. | Shown once, when the token is created. |

Until both variables exist the mirror job is skipped, so a release never turns red just
because the mirror is not configured yet.

```bash
gh variable set DOWNLOAD_MIRROR_S3_ENDPOINT --repo pillardash-oss/codeinoven
gh variable set DOWNLOAD_MIRROR_S3_BUCKET --repo pillardash-oss/codeinoven
gh secret set DOWNLOAD_MIRROR_S3_ACCESS_KEY_ID --repo pillardash-oss/codeinoven
gh secret set DOWNLOAD_MIRROR_S3_SECRET_ACCESS_KEY --repo pillardash-oss/codeinoven
```

---

## 2. Local development (never committed)

Copy `.env.example` → `.env` for local runs. These are your own secrets; keep
them out of git (`.env*` is gitignored).

| Variable | Where to get it |
| -------- | --------------- |
| `CUA_DRIVER_PATH` | Optional   path to a CUA driver binary if it's not on `PATH`. |
| `CODEINOVEN_UTILITY_BRIDGE_URL` / `CODEINOVEN_UTILITY_BRIDGE_TOKEN` | Only if you run the internal utility bridge service. |

---

## 3. Rotation runbook

Rotate (generate a new value) whenever a secret may have leaked:

1. **GitHub Actions secrets**   generate a new cert/`.p12`, regenerate the
   app-specific password, then `gh secret set` each one again.
2. **Apple notarization**   if `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD` leak,
   revoke the app-specific password at appleid.apple.com and generate a new one.
3. **Download mirror R2 token**   if the access key leaks, delete the token in
   **R2 → API → Manage API tokens**, create a new one, and update both
   `DOWNLOAD_MIRROR_S3_*` secrets. The bucket holds only published installers, so
   nothing needs rebuilding; the next mirror run re-uploads as needed.

> If a secret ever appears in git history, **rotate it first**, then scrub the
> history before relying on it   the repo is public.

---

## 4. Quick reference: where things live

| Secret | Store |
| ------ | ----- |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | GitHub Actions secrets (repo) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | GitHub Actions secrets (repo) |
| `GITLEAKS_LICENSE` | GitHub Actions secrets (repo) |
| `DOWNLOAD_MIRROR_S3_ACCESS_KEY_ID`, `DOWNLOAD_MIRROR_S3_SECRET_ACCESS_KEY` | GitHub Actions secrets (repo) |
| `DOWNLOAD_MIRROR_S3_ENDPOINT`, `DOWNLOAD_MIRROR_S3_BUCKET`, `DOWNLOAD_MIRROR_S3_REGION` | GitHub Actions variables (repo) |
| Local-only vars | `.env` (gitignored) |
