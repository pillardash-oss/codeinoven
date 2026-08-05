# Secrets & Environment Variables Guide

Where every secret lives, where to get it, and where to put it. Work top to
bottom before your first release. Never commit any of these values to the
repository.

---

## 1. GitHub Actions secrets — release signing (required for the `release.yml` / `nightly.yml` workflows)

These are stored in **GitHub → repo → Settings → Secrets and variables → Actions**
for `pillardash-oss/codeinoven` (and the same for the website repo if it
publishes artifacts).

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

---

## 2. Website deployment secrets (Coolify)

> **This section applies only to the marketing website repository
> (`pillardash-oss/codeinoven-site`), not to the CodeInOven desktop app.**
> The desktop app has no server component — it is distributed through GitHub
> Releases and updates itself via the built-in auto-updater. Only the website
> (and the AI Agent Icons Directory app inside it) is deployed to your own
> server, and that is where Coolify comes in.

These live in **Coolify → your project → Environment Variables** for the
`codeinoven-site` deployment. Never in the repo, never in a committed `.env`.

| Variable | What it is | Where to get it |
| -------- | ---------- | --------------- |
| `ORIGIN` | Public URL of the deployed site (adapter-node requirement). | The site URL, e.g. `https://codeinoven.com`. |
| `DATA_DIR` | SQLite data path inside the container (persisted volume). | Keep the default `/app/data`. |
| `GITHUB_TOKEN` | Token for the icon crawler to raise GitHub API rate limits (60/h anonymous → 5000/h authed). | GitHub → Settings → Developer settings → **Fine-grained personal access token** (read access to public repos) or a classic token with `public_repo`. |
| `ENABLE_CRON` | Whether the container runs the daily crawl cron. | Set `false` and use a Coolify scheduled task instead if you prefer. |
| `CRAWL_CRON` | Cron expression for the crawl. | Default `0 4 * * *`. |
| `PORT` | Container port. | Keep `3000`. |

**How to set:** Coolify UI → your deployment resource → Environment Variables →
add each variable. Also configure the **persistent volume** (`/app/data`) and
the domain/HTTPS on the Coolify resource.

---

## 3. Local development (never committed)

Copy `.env.example` → `.env` in each repo for local runs. These are your own
secrets; keep them out of git (`.env*` is gitignored).

| Variable | Where to get it |
| -------- | --------------- |
| `CUA_DRIVER_PATH` | Optional — path to a CUA driver binary if it's not on `PATH`. |
| `CODEINOVEN_UTILITY_BRIDGE_URL` / `CODEINOVEN_UTILITY_BRIDGE_TOKEN` | Only if you run the internal utility bridge service. |
| `GITHUB_TOKEN` (website) | Same token as the Coolify `GITHUB_TOKEN` above. |

---

## 4. Rotation runbook

Rotate (generate a new value) whenever a secret may have leaked:

1. **GitHub Actions secrets** — generate new cert/`.p12`, regenerate the
   app-specific password, then `gh secret set` each one again.
2. **Coolify** — update the environment variable in the Coolify dashboard and
   redeploy.
3. **Apple notarization** — if `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD` leak,
   revoke the app-specific password at appleid.apple.com and generate a new one.
4. **Crawler token** — regenerate the GitHub token and update both Coolify and
   your local `.env`.

> If a secret ever appears in git history, **rotate it first**, then scrub the
> history before relying on it — the repo is public.

---

## 5. Quick reference: where things live

| Secret | Store |
| ------ | ----- |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | GitHub Actions secrets (repo) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | GitHub Actions secrets (repo) |
| `GITLEAKS_LICENSE` | GitHub Actions secrets (repo) |
| `ORIGIN`, `DATA_DIR`, `GITHUB_TOKEN`, `ENABLE_CRON`, `CRAWL_CRON`, `PORT` | Coolify project env vars |
| Local-only vars | `.env` (gitignored) |
