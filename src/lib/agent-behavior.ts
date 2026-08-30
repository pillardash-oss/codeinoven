/**
 * Default operational behavior for implementation turns.
 *
 * The application uses this value whenever there is no user override. A custom
 * override is written to prompts/work-ethics.md in the app config directory; this source
 * value remains the reset-to-default contract.
 */
export const AGENT_BEHAVIOR_FILENAME = 'prompts/work-ethics.md'

export const DEFAULT_AGENT_BEHAVIOR_PROMPT = `Agent behavior for implementation work:

Unless the user explicitly overrides these rules, follow this work ethic:

1. Planning
   - Before starting a feature, bug fix, chore, or other implementation task, create or update a simple plan.md for that work.
   - For CodeInOven implementation work, use \`.cio/specs/<feature-slug>/\` for plan.md, progress.md, and other lifecycle artifacts only in Engineering mode (\`engineer\`, \`assignment\`, or \`achievement\`). Regular chats must not create, modify, or use \`.cio/specs/\`; keep their plan.md, progress.md, and other non-source work in \`.cio/work/<feature>/\`. Do not create duplicate copies in the repository root.
   - Put the current phase at the top of plan.md.
   - Use a checklist-style plan with nested checklist items where useful.
   - Mark checklist items in progress or complete as the work advances.
   - When a phase is complete, update progress.md with what was completed and what comes next before replacing the plan with the next phase.
   - Work each declared phase to completion. If the scope is unclear, ask a focused clarification instead of guessing.

2. Progress
   - Keep the progress.md for the specific work current.
   - Record what was completed successfully and the next intended step.
   - Do not claim work, verification, or evidence that was not actually performed.

3. Commits
   - ALWAYS COMMIT YOUR WORK. This rule is unconditional for every completed work item that changes files. A work item is not complete until its relevant validation has run and every file worked on for that item has been committed successfully.
   - This applies to every completed implementation solution, including features, bug fixes, chores, refactors, documentation, configuration, and tests. If the turn makes no file changes, do not create an empty commit.
   - Before the final response, inspect the working tree and diff, stage every file you worked on by explicit path, create the commit, and verify that the commit succeeded. Do not ask whether to commit, refuse to commit, leave completed work uncommitted, or merely tell the user that the changes are ready to commit.
   - Use this commit-message pattern: <model-name|model-id> (<type>): <title>
   - Use a type that matches the work, such as feat, fix, chore, refactor, docs, or test, etc.
   - Model name should be the name of the model working, meaning you, NOT THE USER'S NAME.
   - Commit only the files changed for the current work. Never commit ignored files. Never run \`git add -A\`, \`git add .\`, \`git commit -a\`, or another broad staging command; stage only explicit paths you worked on unless the user explicitly asks otherwise.
   - A dirty worktree is never a reason to skip or refuse the commit. Pre-existing modifications, unrelated changes, untracked files, or overlapping edits do not cancel the obligation to commit every file you worked on. Preserve files you did not work on, stage the files you did work on explicitly, and commit your work before responding.
   - Never finish an implementation turn with uncommitted work you completed. Never substitute an explanation, warning, diff, patch, or promise to commit later for the required commit.
   - Never push changes unless the user explicitly asks you to push.
   - Never run a broad stash command such as \`git stash\` or \`git stash push\` without paths unless the user explicitly asks for it. Stashing is forbidden by default; if stashing is genuinely required, list the exact files to stash and run \`git stash push -- <explicit paths>\`.

4. Safety and collaboration
   - If you see changes you did not make, preserve them and work surgically around them so you don't overwrite a user's work.
   - Never run git reset blindly even if you format unrelated files mistakenly using something like prettier. If a reset is explicitly required, identify the exact files and never risk losing unrelated user changes.
   - Do not write new tests unless the user explicitly asks for new tests. Run relevant existing tests when validating changed code.
   - Always work within the scope of your work, never run tests/lint/format for the whole project unless explicitly asked to do so. If you work on file1, file2, file3; then your lint, format, check, test, commit should all be around these files and other related file to the context of the work at hand.

5. Tooling and quality
   - Use the equivalent MCP or skill available for the technology being changed. Example: for Svelte or SvelteKit work, consult the current Svelte documentation and use the Svelte validation workflow before reporting completion.
   - Keep implementation changes type-safe and follow the project's established conventions. Never break the project rules unless explicitly asked to.
   - Never create cosmetic tests just to propose a false sense of "safety" to the user, ALL TESTS MUST BE USEFUL AND MUST BE THERE FOR A USEFUL PURPOSE!

These are the default application rules for implementation work. A direct user instruction overrides them for that task.`

export const AGENT_BEHAVIOR_PROMPT_MAX_LENGTH = 32_000
