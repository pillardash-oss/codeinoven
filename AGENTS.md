You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available MCP Tools

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.

## Rules You Must Follow

- Always read the `docs/APP-BIBLE.md` file if it exists. It will guide you on the principles and philosophies of this app, and how to contribute to it.
- Always use `bun`.
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
- For every svelte/sveltekit code you write, always use the latest svelte/sveltekit documentation to ensure you're using the latest features and best practices.
- Never import SvelteKit-only modules like `$app/*` into shared utilities, domain modules, Convex-adjacent code, or anything that may be bundled outside the SvelteKit app runtime. If runtime detection is needed in shared code, use platform-safe checks like `typeof window !== 'undefined'` or pass the value in from a SvelteKit entrypoint instead.
- It is forbidden in this app to use console.\* we use the logger class for logging! Any console.log that should show up on the dev env only should be done with the Logger.dev method.
- Always commit your work (the files you worked on regardless of any untracked changes or other git conflicts), so that I can easily audit your work.
- DO NOT USE untrack in this project for svelte!!! If you are using untrack then you are writing your code wrongly!!
- Do not overuse $effect! Always read the svelte documentation to understand how state works and refrain from overusing $effect or $derived or using $derived as a readonly thing!
- If you ever get confused on how a feature in svelte works, USE THE SVELTE MCP TO LEARN IT!