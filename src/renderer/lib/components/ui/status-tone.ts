/**
 * Semantic status tone shared by the status-pill vocabulary.
 *
 * Kept in a plain module (not inside `StatusPill.svelte`) so pure TypeScript
 * modules can reference the tone type without importing from a component.
 */
export type StatusTone = 'success' | 'danger' | 'warning' | 'neutral' | 'info'
