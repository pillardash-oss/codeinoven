/**
 * The harness CodeInOven ships and defaults to. Pi is bundled with the
 * application binary, so every fallback that needs "the default harness"
 * resolves to this id instead of a scattered harness-name literal.
 *
 * The full harness catalog (which harnesses exist, how they are probed, their
 * order in the pickers) remains the main process's single source of truth in
 * `src/main/agents/harness-registry.ts`; this shared constant only names the
 * default so main and renderer fallbacks can never drift apart.
 */
export const DEFAULT_HARNESS = 'pi'
