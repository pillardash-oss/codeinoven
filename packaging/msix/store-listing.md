# Microsoft Store listing: submission sheet

Field-by-field copy for a CodeInOven MSIX submission in Partner Center. Every
claim here is traceable to a file in this repository; the paths are cited under
each field. Fenced blocks are ready to paste.

Fields are grouped in the order Partner Center presents them for a new MSIX
submission: identity and pricing, then the Store listing, then support and
legal, then age rating, then the restricted-capability justification. Uploading
the `.msix` and reserving the product name come first and are covered in
[`packaging/msix/README.md`](README.md).

---

## 1. Product name

```
CodeInOven
```

The reserved name has to agree with what the package declares. `appx.displayName`
is `CodeInOven` in `electron-builder.yml`, the product name comes from `APP_NAME`
in `src/lib/brand.ts`, and Partner Center assigns `Package/Identity/Name` and
`Package/Identity/Publisher`, which are pasted byte for byte into
`appx.identityName` and `appx.publisher` before the build (`packaging/msix/README.md`).

---

## 2. Category and subcategory

```
Developer tools
```

Recommended because the product is a software engineering workspace: it drives
coding agents, git worktrees, a terminal, a repository editor and a pull request
panel (`README.md`, "What it does" and "What is in the workspace"). Productivity
or Utilities would mislead a buyer who arrives from a search for an agentic
coding tool. Developer tools is a top-level Store category; if Partner Center
presents a subcategory selector for it, leave it empty rather than inventing one.

---

## 3. Pricing

```
Free
```

Free of charge, with no trial, no subscription, no in-app purchase and no
advertising. The source is MIT licensed (`LICENSE`, `package.json`), and the
codebase contains no payment or licensing SDK to charge through.

---

## 4. Markets and availability

Recommended: every market Partner Center offers, in the **Windows 10/11
Desktop** device family, x64 only.

- The package is built for x64: `scripts/msix.ts` defaults `--arch` to `x64` and
  the CI leg builds that one package (`packaging/msix/README.md`).
- Minimum platform is Windows 10 version 1809, `10.0.17763.0`, with
  `maxVersionTested` at `10.0.26100.0` (`electron-builder.yml`, `appx`). Both are
  declared in the manifest, so answering "Windows 10, version 1809 or later" is
  consistent rather than optimistic.
- Do not tick Xbox, HoloLens or any non-desktop device family. There is no ARM64
  package, so do not advertise Windows on ARM.
- Availability is not limited by the app: it needs no server of ours, no account
  and no purchase (`README.md`, "Data and privacy", and `docs/SECRETS.md`).

---

## 5. Store listing: language

```
en-US
```

The app has no i18n layer, and the package declares `en-US` as its only language
(`electron-builder.yml`, `appx.languages`). The listing language has to agree
with it (`packaging/msix/README.md`, "Known gaps").

---

## 6. Description (limit 10,000 characters)

```
CodeInOven is a desktop workspace for coordinated agentic software engineering. It runs the coding agents you already have on your machine, keeps their plans and permission requests reviewable, and lands the change in your own repository as a diff you can inspect and roll back.

It is the workspace around the agent, not another agent.

RUN THE AGENTS YOU ALREADY TRUST

CodeInOven detects the coding agents installed on your machine and lets you pick one per thread: Pi, Codex CLI, Claude Code, OpenCode, Cline, Antigravity and Muse Code. Pi ships inside the app, so a fresh install is useful before you install anything else. Nothing is locked to a single agent, and the app hands you the vendor's own install, update or uninstall command instead of changing your machine quietly.

A LIFECYCLE IN FRONT OF IMPLEMENTATION

Stages are switches on a thread. Enable any combination and the workspace runs them in a fixed order:

- Brainstorm: research, decisions and optional prototypes for a rough idea.
- PRD: a versioned requirements document with goals, non-goals and acceptance criteria.
- Spec: an implementation contract you approve before any code is written.
- Assignment: a reviewable task graph, with worker threads that can each run in their own git worktree.
- Achievement: implement, audit and rework in a loop until the goal passes or fails hard.
- Auto Pilot: the whole chain with nobody answering gates.

An audit pass reports independently of the agent that wrote the code.

KEEP THE RUN VISIBLE

Reasoning, tool calls, commands, file reads, diffs and checkpoints stay on screen while the work happens. Permission requests arrive as cards you answer in place. Checkpoints put a thread back to an earlier state, and sub-agents appear as child cards with their own sessions and their own history.

REAL TOOLS, IN ONE WINDOW

- A terminal attached to the active scope root, docked or fullscreen.
- An inner browser with one isolated session per project, for testing a running app or reading documentation. The agent can drive it through a tool, and it runs with no preload and no Node access.
- A file explorer and an in-place editor for the project you opened.
- A git panel for branches, stashes, staging, commits and diffs, with GitHub pull request review including conversation, checks and merge dialogs, and a merge-conflict editor.
- Scopes that own git worktrees, with health, repair and confirmations that check for dirty files and unpushed commits first.
- Assistants and tasks that run an agent on a schedule, one fresh thread per run, with missed-run detection.
- Local dictation, spoken replies and transcript cleanup through models you download, with every attempt, successful or failed, kept in a bounded history you can review and delete.
- Remote machines, called ovens, driven over SSH so long work can run somewhere other than the laptop in front of you.

MODELS

Models come from the harness you choose, so anything that agent supports is available. On top of that, CodeInOven speaks OpenAI-compatible and Anthropic-compatible endpoints, which covers a hosted provider and the local servers you may already run, such as Ollama, LM Studio or llama.cpp. Requests go from your machine to the provider you configured. CodeInOven hosts no relay of its own and never sees your provider key.

YOUR DATA

All application state lives under one configuration directory, %USERPROFILE%\.config\pillardash\codeinoven. Provider credentials are encrypted at rest through the operating system's secure storage. Your tracked files change only through agent actions you approve, your own edits in the file editor and git panel, and the git commands you run.

The app sends one anonymous daily active ping unless you turn it off in Settings, About. It carries no prompts, no file paths, no project names and no repository content. The privacy policy describes every network destination in full, including that ping, the providers you configure and GitHub when you connect it.

WHAT THE STORE BUILD DOES NOT DO

- It does not add Explorer context menu verbs. "Open in CodeInOven" for folders, folder backgrounds and files is installed by the standalone installer, not by the Store package.
- It does not update itself. The Microsoft Store delivers updates once a new package passes certification.
- It is English only.
- It does not include a purchase, a subscription or an account of any kind.

SUPPORT AND LICENSE

CodeInOven is free and open source under the MIT License, published by Pillardash Solutions Limited. Bug reports and feature requests go to the project's issue tracker, and a redacted diagnostics bundle can be exported from Settings when you need to attach something reproducible.
```

The same claims appear in `README.md` ("What it does", "The engineering
lifecycle", "Models", "What is in the workspace", "Data and privacy") and in
`packaging/msix/README.md` ("Known gaps"). Keep `%USERPROFILE%` in the path:
plain Windows users will read it faster than the `~` form.

---

## 7. Short description

Limit: 270 characters, which is the Store's short description field. The fenced
text below is well inside it, so paste it as it stands.

```
A desktop workspace for agentic software engineering. It runs the coding agents you already have, keeps plans and permission requests reviewable, and lands changes in your own repository as a diff you can inspect and roll back.
```

---

## 8. Product features

Limit: 20 items, each up to 200 characters. These are 20, in the order they
appear in the description above.

```
Drives Pi, Codex CLI, Claude Code, OpenCode, Cline, Antigravity and Muse Code, detected on your machine
Pi ships inside the app, so a fresh install runs without extra setup
Lifecycle stages for Brainstorm, PRD, Spec, Assignment, Achievement and Auto Pilot
Working trace: reasoning, tool calls, file reads, diffs and checkpoints stay visible
Permission requests answered in place, per thread
Terminal attached to the active scope root, docked or fullscreen
Inner browser with one isolated session per project, no preload and no Node access
File explorer and in-place editor for the project you opened
Git panel for branches, stashes, staging, commits and diffs
GitHub pull request review with conversation, checks and merge dialogs
Merge-conflict editor for the branches an agent produced
Scope-owned git worktrees with health, repair and guarded destructive actions
Scheduled assistants and tasks, one fresh thread per run, with missed-run detection
Sub-agent cards with their own sessions and history
Checkpoints with selective rollback for a single thread
Local dictation, spoken replies and transcript cleanup through downloaded models
OpenAI-compatible and Anthropic-compatible endpoints, including Ollama, LM Studio and llama.cpp
Provider credentials encrypted at rest through the operating system's secure storage
All application state under one configuration directory, with a diagnostics export when you report a bug
Free and open source under the MIT License
```

---

## 9. Keywords

Limit: 7 terms. Paste one per line if the field is a list, or comma separated if
it is a single box.

```
agentic coding
AI coding agent
Codex CLI
Claude Code
git worktree
local LLM
developer tools
```

Agent names are used to describe what the app can drive, which is how the README
tables present them, not to claim affiliation.

---

## 10. Copyright and trademark info

```
Copyright 2026 Pillardash Solutions Limited. CodeInOven is a product of Pillardash Solutions Limited. Pi, Codex, Claude, OpenCode, Cline, Antigravity and Muse Code are names of their respective owners, used only to describe which tools this application can drive.
```

`LICENSE` carries the MIT copyright line, `package.json` names the author, and
`src/lib/brand.ts` holds the product name and links.

---

## 11. What's new in this version

This changes every release. Copy the section for the version being submitted
from `CHANGELOG.md` and paste it here, staying inside the field's 1,500 character
limit.

```
PLACEHOLDER: replace with the CHANGELOG.md entry for version <version> before
submission. Do not submit this text.
```

---

## 12. Support contact URL

```
https://github.com/pillardash-oss/codeinoven/issues
```

`README.md` links support through the repository, `SECURITY.md` handles
vulnerabilities, and `hey@pillardash.com` (from `package.json` and
`src/lib/brand.ts`) is the address to give if a reviewer asks for a contact
rather than a page. Check that whichever URL you paste loads without a sign-in.

---

## 13. Website URL

```
https://codeinoven.com
```

Note: this domain did not resolve during the last release audit, and confirming
it is still an open item in `docs/RELEASE_CHECKLIST.md` (Launch checklist,
"Confirm the website is live at codeinoven.com"). The URL must resolve before
submission, because a reviewer will open it.

---

## 14. Privacy policy URL

```
https://codeinoven.com/privacy
```

Note: this is a placeholder. The policy text to publish lives in
[`packaging/msix/privacy-policy.md`](privacy-policy.md), and the page it points at
has to resolve before submission. The website did not resolve during the last
release audit (`docs/RELEASE_CHECKLIST.md`), so this URL is a blocker rather than
a formality.

---

## 15. System requirements and age rating

### System requirements

Minimum, as declared by the package manifest (`electron-builder.yml`, `appx`):

```
Minimum: Windows 10 version 1809 (build 17763) or later, 64-bit (x64)
Recommended: Windows 11
```

Additional system requirements, if Partner Center asks for the list:

```
64-bit Windows. There is no ARM64 package.
Git installed and on PATH for the repository, worktree and pull request surfaces.
A network connection to the model provider you configure, and to GitHub if you connect it.
Optional: coding agent CLIs other than the bundled Pi, for example Codex CLI, Claude Code, OpenCode, Cline, Antigravity or Muse Code.
Optional: a microphone and downloaded speech models for dictation and spoken replies.
Optional: an SSH-reachable machine for remote ovens.
```

Rationale: the manifest floor is `minVersion: 10.0.17763.0` with
`maxVersionTested: 10.0.26100.0`; the package is MSIX x64
(`electron-builder.yml`, `scripts/msix.ts`); the app runs `git` as an external
command (`src/main/git/git-service.ts`); Pi is bundled and the other harnesses
come from the user's own install (`README.md`, "Harnesses"); speech models are
separate downloads and the larger ones are a few hundred megabytes
(`docs/SPEECH.md`). No Node.js, Bun, Python or interactive shell is required for
the packaged app to run (`docs/SPEECH.md`, "Runtime policy").

### Age rating (IARC questionnaire)

The questionnaire is answered in Partner Center and IARC generates the rating;
the expected outcome for this app is the lowest category.

- It is a developer tool. There is no content library, no purchase flow, no
  advertising, and no social or messaging feature of its own.
- Answer no to questions about sharing user-generated content, user-to-user
  interaction, gambling, alcohol, tobacco, drugs, sexual content, violence and
  profanity.
- Answer no to questions about purchases and ads.
- The app does contain a browser an agent or the user can point at any address,
  and it displays text that a language model generates. If IARC asks whether the
  product can display unfiltered third-party web content, answer yes: that is
  what the inner browser does (`README.md`, "What is in the workspace";
  `docs/EMBEDDED_BROWSER_ARCHITECTURE.md`).
- Do not claim that model output is reviewed or filtered. It is not; the app
  shows the agent's output and your repository's content.

---

## 16. Restricted capability justification (runFullTrust)

The package declares `runFullTrust` (`electron-builder.yml`, `appx.capabilities`),
which is a restricted capability. This is the text for the justification box,
around 500 characters:

```
CodeInOven is a full-trust desktop application for software development. It hosts hardware-accelerated Chromium windows for its own interface and per-project browser, runs a PTY-backed terminal driving the user's real shell, and launches local processes such as coding agent CLIs, model runtimes and git. It reads and writes project files and repositories the user opens, and listens for microphone audio only when the user starts dictation. None of this is possible inside an AppContainer, so the package declares runFullTrust.
```

Keep it factual rather than persuasive. A reviewer checks it against what the
package actually does, and every sentence above is something the app does
(`src/main/browser/browser-service.ts`, `src/main/system/pty-service.ts`, the
speech runtime policy in `docs/SPEECH.md`, `src/main/git/git-service.ts`,
`src/main/drivers/`).

---

## 17. Before you submit

Fields that need a human decision, or a URL that has to resolve first:

- [ ] `codeinoven.com` resolves. Currently an open launch item in
      `docs/RELEASE_CHECKLIST.md`.
- [ ] `https://codeinoven.com/privacy` resolves and serves the text in
      `packaging/msix/privacy-policy.md`.
- [ ] The support URL loads without a GitHub sign-in.
- [ ] `appx.identityName` and `appx.publisher` are pasted from Product management > Product identity, and `bun run msix:check` passes (`electron-builder.yml`
      still carries `REPLACE_WITH_...` placeholders).
- [ ] `appx.displayName` matches the reserved product name.
- [ ] The version being submitted has a `CHANGELOG.md` entry copied into "What's
      new in this version", replacing the placeholder.
- [ ] The package version is `major.minor.patch.0` and the pre-1.0 warning is
      understood: `0.5.x` produces `0.5.x.0`, whose first section is 0, which the
      Store may reject (`packaging/msix/README.md`, "Version numbering").
- [ ] The listing language is `en-US` and matches `appx.languages`.
- [ ] At least one screenshot at 1366x768 or larger. `docs/media/` has app,
      start screen, toolbox and scopes board captures that can be cropped to the
      Store's aspect ratios.
- [ ] Someone has accepted that the Store build ships without Explorer context
      menus and without self-update, and that both are documented behaviour
      rather than regressions (`packaging/msix/README.md`, "Known gaps").
- [ ] x64 only is a deliberate decision, and no ARM64 package is promised.

---

## Sources read for this sheet

`README.md`, `package.json`, `LICENSE`, `electron-builder.yml`,
`docs/APP-BIBLE.md`, `docs/SECRETS.md`, `docs/SPEECH.md`,
`docs/RELEASE_CHECKLIST.md`, `docs/OVEN-SETUP.md`,
`docs/EMBEDDED_BROWSER_ARCHITECTURE.md`, `packaging/msix/README.md`,
`packaging/winget/README.md`, `src/lib/brand.ts`, `scripts/msix.ts`,
`src/main/ipc/handlers/system-handlers.ts`, `src/main/git/git-service.ts`.

## Unverified in this sheet

- Whether `codeinoven.com` and `https://codeinoven.com/privacy` resolve today.
  The last audit recorded the domain as not resolving.
- Whether the GitHub issue tracker is publicly writable. The repository is public
  and issue forms are described as enabled in `docs/RELEASE_CHECKLIST.md`, but
  that cannot be confirmed from the code.
- Exact per-field character limits. The ones stated here (10,000 for the
  description, 270 for the short description, 20 features at 200 characters,
  7 keywords, 1,500 for "What's new") are the values this sheet is written
  against; Partner Center's live counter is authoritative if it disagrees.
- The Store's approval of `runFullTrust` for this package, and whether reviewers
  ask for a demonstration of the terminal or the embedded browser.
- How the package behaves on Windows on ARM. Only x64 is built.
- Installed footprint and download size of the MSIX, which depends on the build.
