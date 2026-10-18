/**
 * Renderer-facing entry for the shared task-list parser.
 *
 * The parsing lives in `src/lib/agent-todos.ts` so the main process can run the
 * exact same parse at turn end (the engine's task-list reconciliation guard).
 * This file stays the composition root so every `$lib/agent-todos` import
 * keeps working unchanged, per the app's split convention.
 */
export * from '../../lib/agent-todos'
