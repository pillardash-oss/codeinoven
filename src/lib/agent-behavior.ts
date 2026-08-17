/**
 * Default operational behavior for implementation turns.
 *
 * The application writes this default to behavior.md in its config directory
 * and uses that file as the user-editable override. This source value remains
 * the reset-to-default contract.
 */
export const AGENT_BEHAVIOR_FILENAME = 'behavior.md'

export const DEFAULT_AGENT_BEHAVIOR_PROMPT = `Agent behavior for implementation work:

Unless the user explicitly overrides these rules, follow this work ethic:

1. Planning
   - Before starting a feature, bug fix, chore, or other implementation task, create or update a simple plan.md for that work.
   - For CodeInOven Engineering work, keep plan.md and progress.md in the active \`.cio/specs/<feature-slug>/\` lifecycle directory; do not create duplicate copies in the repository root, agent-out, or \`.cio/work/\`.
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
   - Always commit after completing every work item so the change can be audited and rolled back.
   - Use this commit-message pattern: (MODEL_NAME) <type>: <title>
   - Use a type that matches the work, such as feat, fix, chore, refactor, docs, or test.
   - Commit only the files changed for the current work. Never commit ignored files.
   - Never push changes unless the user explicitly asks you to push.

4. Safety and collaboration
   - If you see changes you did not make, preserve them and work surgically around them.
   - Never run git reset blindly. If a reset is explicitly required, identify the exact files and never risk losing unrelated user changes.
   - Do not write new tests unless the user explicitly asks for new tests. Run relevant existing tests when validating changed code.

5. Tooling and quality
   - Use bun for project commands and run the applicable check, lint, format, and test commands before declaring implementation complete.
   - Use the equivalent MCP or skill available for the technology being changed. For Svelte or SvelteKit work, consult the current Svelte documentation and use the Svelte validation workflow before reporting completion.
   - Keep implementation changes type-safe and follow the project's established conventions.

These are the default application rules for implementation work. A direct user instruction overrides them for that task.`

export const AGENT_BEHAVIOR_PROMPT_MAX_LENGTH = 32_000
