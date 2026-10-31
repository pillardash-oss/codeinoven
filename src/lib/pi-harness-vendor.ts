/**
 * Paths inside the bundled Pi harness that two sides have to agree on: the build
 * writes them (`scripts/pi-harness-bundle.ts`) and the packaged app imports them
 * at runtime (`src/main/providers/pi-ai-registry.ts`). They live here so a rename
 * cannot leave the build shipping a file nobody loads, which would only surface in
 * a packaged app as a provider catalog that silently fell back to a stale copy.
 */

/** Directory the harness keeps its vendored libraries in (not `node_modules`:
 *  see the copy site in the bundle script for why that name is avoided). */
export const PI_HARNESS_VENDOR_DIRECTORY = 'vendor'

/**
 * Self-contained ES module holding pi-ai's provider registry.
 *
 * It is a build output, not a copy: pi-ai's `dist` reaches `pi-telemetry`,
 * `typebox`, `openai`, `@google/genai`, `@anthropic-ai/sdk` and `partial-json` by
 * package name, and none of those resolves in the packaged app.
 */
export const PI_HARNESS_PI_AI_REGISTRY_FILE = 'pi-ai-registry.mjs'
