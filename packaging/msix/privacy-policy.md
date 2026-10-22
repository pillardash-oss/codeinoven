# CodeInOven privacy policy

Effective date: October 22, 2026.

Pillardash Solutions Limited publishes CodeInOven, a desktop application for
coordinated agentic software engineering. This policy describes what the
application does with data on the machines where it is installed. It covers the
Windows package distributed through the Microsoft Store, the Windows installer
downloaded from our site, and the macOS and Linux builds, which share one
codebase.

The application is open source under the MIT License. The statements below about
what the software does can be checked against the code at
[github.com/pillardash-oss/codeinoven](https://github.com/pillardash-oss/codeinoven),
and the project-relative source paths are cited so a reader can find them.

Contact for anything in this policy: **hey@pillardash.com**.

---

## 1. The short version

- CodeInOven is local-first. Projects, threads, specifications, history and
  settings are stored on your computer, in one configuration directory.
- There is no CodeInOven account, and we operate no server that receives your
  work, your prompts, your code or your repository.
- Your work leaves your computer only when you point the app at something: a
  model provider you configured, a GitHub account you connected, a remote
  machine you added, or a web page you opened in the built-in browser.
- We receive one thing: an anonymous daily active ping, which is on by default
  and can be switched off in Settings.

---

## 2. What is stored on your device

All application state lives under a single configuration directory
(`src/lib/utils.ts`, and `README.md`, "Data and privacy"):

- Windows: `%USERPROFILE%\.config\pillardash\codeinoven`
- macOS and Linux: `~/.config/pillardash/codeinoven`

Inside it:

- **Projects, threads, messages, specifications, plans, audits, checkpoints,
  memory, learned dictation lessons and usage records.** The larger stores live
  in a SQLite database, `codeinoven.db`, in the same directory, and history is
  written in bounded chunks.
- **Provider credentials and other secrets**, encrypted through the operating
  system's secure storage (`src/main/storage/secret-vault.ts`). On Windows that is
  DPAPI; macOS and Linux use their own keychain or secret service. A vault that
  cannot encrypt does not fall back to plaintext.
- **Logs**, partitioned into one folder per local day, `logs/<YYYY-MM-DD>/`
  (`docs/APP-BIBLE.md` section 4.2, `src/main/system/log-paths.ts`). Log lines
  contain operational detail such as failures, command names and file paths.
  Credentials, tokens and passwords are redacted before a line is written
  (`src/main/system/logger.ts`).
- **Speech data**: recorded audio for each dictation attempt, its raw and cleaned
  transcript, and the downloaded speech models themselves
  (`docs/SPEECH.md`, "Recording and storage"). Speech history defaults to 30
  attempts and can be set from 1 to 500; the oldest attempt and its audio are
  removed when the limit is reached.
- **Browser session cookies** for the built-in browser, encrypted at rest with
  the same operating-system storage. A cookie jar is never written to a
  plaintext backend (`src/main/browser/browser-service/browser-session-cookies.ts`).
- **Usage records and model rankings** shown on your own Profile and Usage
  pages, and one small file, `analytics/usage.json`, that remembers the
  installation identifier described in section 4.6
  (`src/main/system/usage-analytics.ts`).
- **Imported model registrations.** If you point the app at a model file or
  folder you own, the app records the path. Removing the registration does not
  delete your file.

Scopes that use a managed git worktree create worktrees beneath the same
configuration directory, never inside your repository
(`docs/APP-BIBLE.md` section 4.6). Inside a repository you opened, the app writes
only through the git operations you start, the scratch files it keeps under
`.cio/` in that repository (merge-conflict documents, and the design, prototype
and specifications work folders those features use, see
`src/main/git/git-service.ts`, `src/main/design/design-contract-service.ts` and
`src/main/prototypes/prototype-preview-service.ts`), and any edit you or an agent
you approved makes to a tracked file.

---

## 3. Credentials

- API keys for model providers are stored in the encrypted vault and never cross
  the internal process boundary in plaintext (`docs/RELEASE_CHECKLIST.md`,
  section 3).
- A harness that keeps its own login, such as a Claude or Codex sign-in, keeps it
  in that harness's own credential store. CodeInOven reads what it needs to use
  the harness and does not copy the credential into its own files
  (`README.md`, "Data and privacy").
- SSH credentials for remote machines, and any password used to authenticate
  them, are stored in the same encrypted vault (`docs/OVEN-SETUP.md`).
- A GitHub token obtained through the device flow is stored in the vault and
  refreshed there (`src/main/git/github-auth-service.ts`).

---

## 4. What leaves your device

Nothing leaves your computer unless one of the following happens. Each item names
the destination and what is sent.

### 4.1 The model or agent provider you configured

When you send a message, the app assembles a request and sends it from your
machine directly to the provider you selected. CodeInOven hosts no relay and
never sees the key or the request (`README.md`, "Models"). A request can contain:

- your messages and the agent's conversation history;
- the files, diffs, terminal output and tool results the agent reads or produces
  while working on your repository;
- attachments you add;
- screen captures, when a supported model uses the computer-use bridge, which
  sends a captured frame to the model as an image (`src/main/app-control/app-control-bridge.ts`);
- a short prompt and the text being processed when the app asks the same
  provider for a thread title or for dictation cleanup with remote cleanup
  enabled (`docs/SPEECH.md`, "Lesson learning" and "Cleanup and privacy").

Which provider receives this, and what that provider does with it, is governed by
the provider's own terms and privacy policy, not this one. A local server such as
Ollama, LM Studio or llama.cpp is reached at the address you gave it, so a server
running on your own machine never sends the request off it.

### 4.2 GitHub, when you connect an account

Connecting is optional. The app signs in through GitHub's device flow with the
`repo` and `notifications` scopes (`src/main/git/github-auth-service.ts`), which
means it can read private repositories you have access to. After you connect:

- the app reads repositories, pull requests, conversations, checks, issue and
  pull request metadata, and notifications through `api.github.com`;
- profile pictures and images in pull request bodies are fetched and inlined so
  the renderer can display them (`docs/APP-BIBLE.md`, "GitHub-authored content");
- comments and reviews you submit from the app are posted to GitHub as you wrote
  them;
- Git operations you run, such as fetch, push and pull, contact the remote you
  configured.

Nothing about your threads, local history or prompts is sent to GitHub. You can
disconnect at any time, and you can revoke the app's access on GitHub itself.

### 4.3 Remote machines you add as ovens

An oven is another machine you registered over SSH (`docs/OVEN-SETUP.md`). The
app connects to it directly, installs or updates a small service bundle there,
and sends the file, git and run operations you start. That traffic is between
your computer and that machine. It does not pass through us.

### 4.4 The built-in browser and web pages

The built-in browser is a real Chromium session, isolated per project, with no
preload script and no Node.js access (`README.md`, "What is in the workspace").
Any page opened in it, whether you opened it or an agent did, receives a normal
web request, including your IP address, and can set cookies. Those pages are
third parties and their own policies apply.

### 4.5 Downloads you ask for

Speech models are downloaded from their published sources, for example Hugging
Face, and the optional llama.cpp runtime is downloaded from its official GitHub
release. Every one of those files has a pinned revision, an exact byte count and
a checksum that is verified before it is installed (`docs/SPEECH.md`). Skills,
plugins and MCP utilities installed from Settings are fetched from the sources
they name, which can include `raw.githubusercontent.com`
(`src/main/utilities/skill-market.ts`, `src/main/utilities/agent-plugins.ts`).
As with any download, the host sees your IP address and the request.

### 4.6 The anonymous daily active ping

This is the only data that reaches us, and it is small. It is implemented in
`src/main/system/usage-analytics.ts`.

- **What is sent**: one event named `first_open` on the first launch, and one
  event named `app_active` per day the app is used. Each carries a UTC timestamp,
  the app version, the operating system (`win32`, `darwin`, `linux`) and the
  processor architecture.
- **What identifies it**: a random identifier generated on your machine and
  stored in `analytics/usage.json`. It is not derived from your hardware, your
  name, your GitHub account or any other identifier.
- **What is deliberately excluded**: prompts, messages, file names, repository
  names, project names, thread titles, settings, provider keys, the operating
  system user name and your location. The request explicitly disables person
  profiles, GeoIP lookup and IP capture at the analytics provider
  (`$geoip_disable`, `$ip: null`, `$process_person_profile: false`).
- **Where it goes**: PostHog, at `https://us.i.posthog.com/batch/`. No other
  analytics, crash-reporting or advertising SDK is present in the codebase.
- **When it is sent**: it is on by default in a released build. The switch is
  Settings, About, "Share anonymous daily active ping"
  (`src/renderer/lib/components/settings/AboutCommunity.svelte`). Turning it off
  takes effect immediately: an in-flight request is aborted and queued events are
  discarded. A queue is capped at 30 days and is never sent while consent is off.
- **When it is absent**: a development build, a build without an ingestion token,
  or a launch outside the canonical configuration directory sends nothing
  (`src/main/system/usage-analytics.ts`).

### 4.7 Update checks

The standalone Windows installer and the macOS and Linux builds check a release
feed at `dl.codeinoven.com`, with GitHub Releases as a fallback, every six hours
when an update is possible (`src/main/notifications/updater-service.ts`). The feed
request reveals your IP address to the download host. The Microsoft Store package
does not check for updates at all: the Store delivers them, and the in-app updater
is disabled inside the package (`packaging/msix/README.md`, "Runtime behaviour
under package identity").

### 4.8 Diagnostics, only when you export them

Settings can write a diagnostics bundle to a file you choose
(`src/main/ipc/handlers/system-handlers.ts`). It contains the app version, a
settings summary, project and thread names, usage counters and bounded log
excerpts, with credentials, tokens and passwords redacted
(`src/main/system/diagnostics-service.ts`). It is written where you point it and
is never uploaded by the app. If you attach it to a public issue, treat the
project and thread names in it as public.

### 4.9 Links you open

Choosing a website link in the app, for example our site, the repository or
GitHub, opens your default browser, which makes a normal web request to that
site.

---

## 5. What we never collect

- No account, name, email address, postal address or phone number is required to
  use the app, and there is no sign-in with us.
- No payment information. The app is free, contains no purchases, no
  subscriptions and no advertising, and there is no advertising identifier.
- No prompts, messages, code, repository contents, file names or project names
  are sent to us.
- No location data, contacts, calendar, health data or data from other
  applications.
- We do not sell data, we do not share it with advertisers, and we do not use it
  for cross-app or cross-site tracking. There is no data broker in the path,
  because there is no server of ours in the path.

---

## 6. Microphone and speech

- Audio is used only for the dictation and recording features you start. The
  microphone is requested when you press the microphone button, never at launch
  (`docs/SPEECH.md`, "Recording and storage").
- Transcription and speech synthesis run locally in packaged workers using models
  you download. No cloud fallback is attempted.
- **The one exception** is a switch that is off by default, "Enable voice
  recording" in the Sound page. When it is on, and no local speech-to-text model
  is installed, a finished recording is sent as an audio attachment to an
  audio-capable conversation model you configured, for transcription. With the
  switch off, audio never leaves your machine.
- Cleanup of a transcript can run remotely only if you enable the separate
  "remote cleanup" switch, which also defaults off. In that case only the
  transcript text and minimal formatting context are sent: view kind, project or
  thread labels, active branch, the bounded lesson set for the current mode and
  the behaviour toggles. Audio, source files, full conversation history and
  unrelated project content are excluded (`docs/SPEECH.md`, "Cleanup and
  privacy").
- Finalized dictation replaces the current clipboard contents on purpose, so the
  transcript can appear in your operating system's clipboard history. Treat the
  clipboard as you would any text you copy.
- Deleting a speech attempt deletes its audio and transcripts from your machine.

---

## 7. Children's privacy

CodeInOven is a software development tool. It is not directed at children, and
nothing in it is designed for them. We do not knowingly collect personal
information from children, and the only data we receive is the anonymous ping
described in section 4.6, which carries no identity and no content. A child using
the app does so under an adult's model-provider account, and that provider's own
terms apply to the requests it receives.

---

## 8. Retention

- Data on your machine is kept until you delete it. There is no expiry that
  removes it behind your back, apart from the bounded limits the app applies:
  thread counts per project, history chunk sizes, speech history length (default
  30 attempts), daily log folders, and the 30 day cap on the local analytics
  queue.
- The anonymous ping is queued locally for at most 30 days and sent when the app
  is allowed to send it. Once sent, it is stored by PostHog under that project's
  retention settings.
- We hold no copy of your work to delete, because we never receive it.

---

## 9. Deleting your data

Everything the app stores is in one directory, so deleting it deletes
everything:

1. Quit CodeInOven.
2. Delete `%USERPROFILE%\.config\pillardash\codeinoven` on Windows, or
   `~/.config/pillardash/codeinoven` on macOS and Linux.

That removes the database of projects and threads, the encrypted credential
vault, logs, recorded audio and transcripts, downloaded speech models and the
local analytics state, including the installation identifier. Speech models and
the optional llama.cpp runtime are inside that directory, so they go with it.

Deleting the Microsoft Store package, or running the uninstaller from the
standalone installer, removes the application but not that directory, because it
holds your work. Delete the directory separately if you want it gone.

If you prefer to delete selectively, the app offers deletion for threads,
projects and scopes, a clear action for the local usage analytics records on the
Profile settings page, deletion of individual speech attempts after a
confirmation, and the consent switch for the anonymous ping.

Two things are not in that directory:

- **GitHub access.** Disconnect the account in Settings and, if you want the grant
  gone, revoke the application on GitHub under Settings, Applications.
- **Remote machines.** An oven keeps the service bundle the app installed on it.
  Removing the oven from Settings unregisters it; the service and its files on the
  remote machine have to be removed there (`npx @pdslng/cio-oven stop`,
  `docs/OVEN-SETUP.md`).

Revoking the anonymous ping is enough to stop further pings, but events already
sent cannot be recalled individually. Since they carry no identity beyond a random
installation identifier that is deleted with the directory, there is nothing left
to link them to you.

---

## 10. Security

- Credentials are encrypted with the operating system's secure storage; there is
  no plaintext fallback.
- The renderer has no direct filesystem or network access to your machine's
  internals. It talks to the main process over a typed, validated contract
  (`docs/APP-BIBLE.md`, section 1).
- The built-in browser runs with no preload script and no Node.js access, in a
  session isolated per project.
- The application is open source, and releases are built in public CI with
  checksums published alongside the artifacts.

To report a vulnerability, use the private advisory at
[github.com/pillardash-oss/codeinoven/security/advisories/new](https://github.com/pillardash-oss/codeinoven/security/advisories/new)
or write to hey@pillardash.com. Please do not open a public issue for a security
problem.

---

## 11. Changes to this policy

When the app's behaviour changes, this document changes with it. The effective
date at the top is updated, the revised text is published at the same URL, and a
change that affects what leaves your machine is called out in the release notes
for the version that introduces it. The version of this document in the
repository, `packaging/msix/privacy-policy.md`, is the source of the published
page.

---

## 12. Contact

Pillardash Solutions Limited
hey@pillardash.com

Write to that address for any question about this policy, to ask what data is
held about you, or to ask for deletion. Because the app sends us nothing but the
anonymous ping, there is usually nothing on our side to find, and we will say so
plainly rather than describing a data inventory we do not have.

---

## Unverified

These points cannot be confirmed from this repository and must be checked before
the policy is published:

- **Whether the published page exists.** The policy has to be served at a URL that
  resolves. `codeinoven.com` did not resolve during the last release audit
  (`docs/RELEASE_CHECKLIST.md`, launch checklist).
- **PostHog project settings.** Data retention, region and any dashboard access
  for the analytics project are configured in PostHog, not in this repository.
  The endpoints, event names, fields and consent logic above are verified from
  `src/main/system/usage-analytics.ts`.
- **The ingestion token in released builds.** Whether a given build sends the ping
  depends on `CODEINOVEN_POSTHOG_TOKEN` being set at build time
  (`electron.vite.config.ts`). It is not stored in the repository.
- **The website.** This policy covers the desktop application only. Any
  analytics, cookies or forms on codeinoven.com are a separate property in a
  separate repository and are not described here.
- **A postal address and any data-protection officer.** The repository names the
  company and the support address, but no registered company address or
  jurisdiction, so a complete legal notice needs both added here.
- **Provider and GitHub behaviour.** What each model provider or GitHub retains is
  governed by their own policies. Those are outside this document and outside
  this repository.
