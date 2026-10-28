You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. It is an app-managed utility rather than a native tool: find it with `cio_util_find` (query "svelte"), activate it with `cio_util_init`, then invoke the operations below with `cio_util_use`. Here's how to use them effectively:

## Available MCP Tools

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
Run it at the start of any task that involves writing or reviewing Svelte/SvelteKit code in this project.

### 2. get-documentation

Retrieves full documentation content for specific sections. `section` accepts a single name or an array, so fetch every relevant section in ONE call.
After calling list-sections, analyze the returned `use_cases` fields and fetch the sections the task actually needs. The server itself warns this call is token intensive, so implement from your own knowledge and let `svelte-autofixer` catch mistakes first; reach for documentation when the task touches runes, routing, or anything you are unsure about, not by default.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions. `code` accepts the component source OR a path to the file, `desired_svelte_version` is 5 for this project (`package.json`), and `filename` is the component name with its extension, never a path. This project does not enable the experimental async option, so leave `async` alone.
You MUST run it over every Svelte file you write or change before reporting the work as done, and iterate until no issues or suggestions are returned.

**Batch it.** Run the whole set of files in ONE code-mode script that loops over them with bounded concurrency and returns only the findings, never one call per file. A 430-file change was once checked with 2,283 separate calls, one file at a time, and that is a defect even when every answer is correct. The gateway's own batch operation cannot carry these calls (it covers the app's read-only tools only), so code mode is the path.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation, and NEVER when the code was written into files in their project, which is the normal case here.

## File Size And Class Decomposition (hard rule)

- NO FILE IN THIS REPOSITORY MAY EXCEED 2000 LINES OF CODE. This is a hard limit, not a target. `src/**` and `tests/**`, TypeScript, Svelte, scripts and styles all count. A change that pushes a file past 2000 lines is rejected, and a file that is already past the limit must be split before you leave it.
- A class or component is a leaf, never a god object. When one file has grown to hold several concerns, split it into a folder named after the file (`chat/chat-engine.ts` becomes `chat/chat-engine.ts` plus `chat/chat-engine/`), where the original file is the composition root and each smaller unit in the folder owns exactly one concern (`chat-engine-sessions.ts`, `chat-engine-turns.ts`, ...).
- Split by concern, never by line count. Every unit owns one job with a name a reader can predict, and the composition root stays the only public surface. Keep the public API stable: the same import path exports the same names as before the split.
- Move code, do not rewrite it. A structural split changes no behaviour, no prop, no export and no signature. New cross-unit access goes through a typed host/context interface, never `as any` and never a widened `unknown` escape hatch.
- Same shape in every layer: pure logic in a plain `.ts` module, reactive state plus its operations in a `.svelte.ts` controller, cohesive markup in a child `.svelte` component with typed props.
- Validate a split with scoped `bun run check`, `bun run lint` and `bun run format` on the files you touched plus their importers, and `bun run test` for the matching tests. A split that cannot be verified is not finished.

## Rules You Must Follow

- CodeInOven stores all threads, sessions, and app data in `~/.config/pillardash/codeinoven/`. When asked to inspect a thread, session, logs, or any stored app data, look there. NEVER use `~/Library/Application Support/CodeInOven` for app data — it contains only Electron/Chromium runtime junk (caches, cookies, an empty db) and inspecting it is always wrong.
- Read the `docs/APP-BIBLE.md` file if it exists. It will guide you on the principles and philosophies of this app, and how to contribute to it. Only read it when necessary.
- Always use `bun`.
- To run the app and probe its behaviour, use `bun run dev:probe` instead of `bun dev`. It launches an isolated instance with its own data root (`.cio/tmp/probe`) and background registration off, so it adds no second menu bar icon, registers no login item, and quits when its window closes. Never probe against the user's live data root, and never leave a probe running in the background.
- Do not use type `any` anywhere in this codebase!
- In svelte when you add an attribute to an element, just like html, the default value is true, so writing something like `<Button active={true}>Sample</Button>` makes no sense, it should simply be `<Button active>Sample</Button>`
- Every icon-only button MUST have both a descriptive `title` and a descriptive `aria-label`. Reusable icon-button components MUST expose a typed, required `title` prop, bind it to the rendered button, and require every call site to provide an action-specific title.
- NEVER use checkbox inputs or checkbox semantics (`<input type="checkbox">`, `role="checkbox"`) anywhere in this app — ALWAYS use the reusable `Switch` component (`src/renderer/lib/components/ui/Switch.svelte`). Markdown task-list checkboxes rendered as user content are the only exception.
- NEVER rely on the native `title` tooltip — it is unreliable. The custom tooltip system (`src/renderer/lib/components/ui/Tooltip.svelte` + `TooltipHost.svelte`) reliably shows a tooltip after 1500ms of hover for every element that carries a `title` attribute, so keep using `title`/`aria-label` as usual and never build ad-hoc tooltip behavior.
- Do not use deprecated codes!
- NEVER write a class like this in svelte: `class:bg-green-500/10` if you want to do this, write it properly `class="bg-green-500/10"`
- Avoid using redundant tailwindcss class like: `text-text-muted text-inherited`
- Avoid using tailwindcss classes like this `z-[10]` when `z-10` is possible
- Do not ever write any typescript code like this: `variable as any`!
- For every svelte/sveltekit code you write, always use the latest svelte/sveltekit documentation to ensure you're using the latest features and best practices, and validate every changed component with the batched `svelte-autofixer` pass described above.
- Never import SvelteKit-only modules like `$app/*` into shared utilities, domain modules, Convex-adjacent code, or anything that may be bundled outside the SvelteKit app runtime. If runtime detection is needed in shared code, use platform-safe checks like `typeof window !== 'undefined'` or pass the value in from a SvelteKit entrypoint instead.
- It is forbidden in this app to use console.\* we use the logger class for logging! Any console.log that should show up on the dev env only should be done with the Logger.dev method.
- Always commit your work (the files you worked on regardless of any untracked changes or other git conflicts), so that I can easily audit your work.
- DO NOT USE untrack in this project for svelte!!! If you are using untrack then you are writing your code wrongly!!
- Do not overuse $effect! Always read the svelte documentation to understand how state works and refrain from overusing $effect or $derived or using $derived as a readonly thing!
- If you ever get confused on how a feature in svelte works, USE THE SVELTE MCP TO LEARN IT!