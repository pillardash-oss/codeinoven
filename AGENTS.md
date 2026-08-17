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

Always read the `docs/APP-BIBLE.md` file if it exists. It will guide you on the principles and philosophies of this app, and how to contribute to it.

### 1. work-ethic

When you want to start a task, first create your plan, and put it in a plan.md file then, ensure you define the phase you are currently working on at the top of the plan.md file, then when you finish a task, update your progress in a progress.md file, stating what you've done successfully, and what you plan on doing next, then mark the task in the plan.md file as in-progress or completed. Do not stop till you have exhaustively completed the phases you are working on. Always commit contextually when you finish a plan, so we can rollback if needs be.

Here is an example of how a plan.md file should look like:

```txt
Current Phase: Phase 1
## Plan: Foundation & Auth ✓ COMPLETE
- [x] **Project Initialization**
  - [x] Initialize Go backend structure (`/cmd/api`, `/internal`, `/pkg`)
```

When you have completed everything in a particular plan.md file and want to move on to the next logical phase update the progress.md file first with your current progress, and overwrite the plan.md file with the new plan of the next step, do not preserve the previous plan you have finished already.
If you are confused at any point ask clarifying questions, do not assume anything!

However, if you have a way to name files like I just described above, maybe in your system instruction, then use that, the plan is to be well organized and for continuity.

### 2. Strict Rules

- Always use `bun`.
- Use `bun run lint [FILES]` to lint files. Lint only files you worked on, never lint the whole repo except explicitly asked to!
- Use `bun run format [FILES]` to fix linting errors that can be fixed. Format only files you worked on. Never format the whole repo except explicitly asked to!
- Use `bun run test [FILES]` to use the defined test script. Test only files you worked on and the files that concerns them. Where they were imported to! Never run test for the whole app except explicitly asked to.
- When formatting and linting, always do so for the files you worked on. And when testing, always test on the files and any additional files that concerns the ones you worked on. Never perform a full repo test/lint/format.
- Always run tests if any before you start fixing, then after to know if you introduced any regression. This should be done after you have determined or estimated the files/areas you would work on.
- Output the result of your test run to the agent-out/test-result directory, calling it (feature)-baseline.txt or (feature)-(1,2,...n).txt or (feature)-final.txt then grep only what you need from the result after the test is done running, something like grep failed or warning, then find the relevant line number in the files so you don't pollute the context with the whole test result (relevant and irrelevant).
- Always commit your work contextually when you're done.
- Do not use type `any` anywhere in this codebase!
- In svelte when you add an attribute to an element, just like html, the default value is true, so writing something like `<Button active={true}>Sample</Button>` makes no sense, it should simply be `<Button active>Sample</Button>`
- Every icon-only button MUST have both a descriptive `title` and a descriptive `aria-label`. Reusable icon-button components MUST expose a typed, required `title` prop, bind it to the rendered button, and require every call site to provide an action-specific title.
- NEVER use checkbox inputs or checkbox semantics (`<input type="checkbox">`, `role="checkbox"`) anywhere in this app — ALWAYS use the reusable `Switch` component (`src/renderer/lib/components/ui/Switch.svelte`). Markdown task-list checkboxes rendered as user content are the only exception.
- NEVER rely on the native `title` tooltip — it is unreliable. The custom tooltip system (`src/renderer/lib/components/ui/Tooltip.svelte` + `TooltipHost.svelte`) reliably shows a tooltip after 1500ms of hover for every element that carries a `title` attribute, so keep using `title`/`aria-label` as usual and never build ad-hoc tooltip behavior.
- Do not use deprecated codes!
- NEVER write a class like this in svelte: `class:bg-green-500/10` if you want to do this, write it properly `class="bg-green-500/10"`
- Avoid using redundant tailwindcss class like: `text-text-muted text-inherited`
- Avoid using tailwindcss classes like this `z-[10]` when `z-10` is possible
- Whenever you finish a project always run the check, lint, format and test commands that are available, fix any errors before stating that you're done
- Do not ever write any typescript code like this: `variable as any`!
- For every svelte/sveltekit code you write, always use the latest svelte/sveltekit documentation to ensure you're using the latest features and best practices.
- Never import SvelteKit-only modules like `$app/*` into shared utilities, domain modules, Convex-adjacent code, or anything that may be bundled outside the SvelteKit app runtime. If runtime detection is needed in shared code, use platform-safe checks like `typeof window !== 'undefined'` or pass the value in from a SvelteKit entrypoint instead.
- When committing, always prepend your commit with your name; example: "(MODEL_NAME) feat: A new feature"; so I can easily recognize your work, and always commit only files you worked on, never do git commit . or git commit -A.
- It is forbidden in this app to use console.\* we use the logger class for logging! Any console.log that should show up on the dev env only should be done with the Logger.dev method.
- Always commit your work (the files you worked on regardless of any untracked changes or other git conflicts), so that I can easily audit your work.
- Always give me a rundown of all you did; what went wrong (if applicable) and how you fixed or approached it and enough info for me to understand your work.
- If you ever have a conflict where the plan.md file or the progress.md file has been overwritten since your last edit, then create a new plan-[feature].md or progress-[feature].md file and continue with that.
- All files for documentation (plan*.md, progress*.md, test-output, walkthroughs, etc) should be placed in the agent-out/ directory. If it doesn't exist, create it, so that the root of the folder is not polluted and remains work only files.
- Never commit an ignored file!
- DO NOT USE untrack in this project for svelte!!! If you are using untrack then you are writing your code wrongly!!
- Do not overuse $effect! Always read the svelte documentation to understand how state works and refrain from overusing $effect or $derived or using $derived as a readonly thing!
- If you ever get confused on how a feature in svelte works, USE THE SVELTE MCP TO LEARN IT!
- DON'T EVER RUN `git push` OR ATTEMPT TO PUSH! It doesn't matter how many commits behind the project is!
- Always use the equivalent MCP/skills available to you when working on various technologies. Example: when working on svelte, always use the MCP to look up docs, test and fix your code!
- Do not write new tests unless explicitly told to.
- IF YOU EVER SEE ANY CHANGES YOU DID NOT MAKE NEVER REVERT SO YOU DON'T DESTROY ANOTHER'S CHANGES!! ALWAYS WORK SURGICALLY!!
- NEVER RUN `git reset` blindly. If you need to revert anything, list the files individually. NEVER CAUSE A USER TO LOSE THEIR CHANGES!
- ALWAYS COMMIT!
