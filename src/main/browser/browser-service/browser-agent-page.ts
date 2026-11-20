/**
 * The page-side half of the agent's browser operations.
 *
 * Every operation that needs to know something about the document runs one of
 * these expressions through `executeJavaScript` in the document's own world.
 * Keeping them here rather than inline in `browser-service.ts` is deliberate: they
 * are the only part of the agent path that is page code, so they are the only part
 * that can be exercised on its own (see `tests/main/browser/browser-agent-page.test.ts`),
 * and one reference/selector scheme shared by the snapshot and every action is
 * what lets an agent act on what it actually read.
 *
 * This file is the composition root: it re-exports the units below it and owns no
 * logic of its own, so every caller keeps importing one module while each unit owns
 * exactly one concern.
 *
 * - `page-toolkit` is the DOM layer everything runs on: references, deep queries
 *   that cross shadow boundaries, composed hit testing, accessible names and states,
 *   and floating layer detection. It is the reason a control inside a web component
 *   or an SVG icon is addressable at all.
 * - `page-snapshot` reads a page broadly (`agentSnapshotScript`) or one element in
 *   full (`agentQueryScript`).
 * - `page-actions` types, selects, ticks, uploads and clicks.
 * - `page-geometry` measures points, frames, scroll and floating layers.
 * - `page-wait` waits for a condition and runs the caller's own expression.
 * - `page-cursor` draws the mark that shows where the agent acted.
 *
 * Three things this module exists to get right:
 *
 * 1. **A snapshot that describes real elements.** The reference it hands out is an
 *    attribute the page itself carries and a node the toolkit remembers, so an action
 *    minutes later still resolves the same element, and each element also reports
 *    the selector a person would write, its live value and state, and its box.
 * 2. **Typing that a framework accepts.** Setting `element.value` is not typing:
 *    React installs its own value setter on the node instance, so the assignment
 *    updates React's value tracker and the `input` event that follows looks
 *    unchanged, which is exactly how a form ends up looking empty while the tool
 *    reports success. The prototype setter is what leaves the tracker stale, and
 *    the read-back in the result is what makes the outcome verifiable instead of
 *    assumed.
 * 3. **A mark nobody mistakes for their own cursor.** The agent's mark is a real node
 *    in the page, marked as the agent's own, so a screenshot shows where it is working
 *    and no snapshot mistakes it for page content.
 */

export {
  AGENT_OWNED_ATTRIBUTE,
  AGENT_REF_ATTRIBUTE,
  AGENT_TOOLKIT_GLOBAL,
  MAX_LABEL_CHARS,
  MAX_LAYERS,
  MAX_OPTIONS,
  MAX_REFS,
  MAX_SHADOW_ROOTS,
  MAX_TEXT_CHARS,
  MAX_VALUE_CHARS,
  SNAPSHOT_ROLE_SELECTOR,
  SNAPSHOT_SELECTOR,
  domClickSource,
  elementPointSource,
  pageRuntimeSource,
  pageToolkitSource,
  pointerCandidateSource,
  toolkitInstallSource,
  type PageToolkitOptions
} from './browser-agent-page/page-toolkit'

export {
  agentQueryScript,
  agentSnapshotScript,
  type AgentQueryOptions,
  type AgentSnapshotOptions
} from './browser-agent-page/page-snapshot'

export {
  agentCheckScript,
  agentComboboxScript,
  agentDomClickScript,
  agentFieldValueScript,
  agentFileInputScript,
  agentFocusScript,
  agentHitTestScript,
  agentListboxOptionsScript,
  agentPrepareTypingScript,
  agentSelectScript,
  agentTypeScript
} from './browser-agent-page/page-actions'

export {
  agentElementPointScript,
  agentElementRectScript,
  agentFrameRectsScript,
  agentFrameRevealScript,
  agentLayersScript,
  agentPageOffsetScript,
  agentScrollScript,
  agentViewportScript,
  type AgentFrameRect
} from './browser-agent-page/page-geometry'

export {
  BROWSER_WAIT_MAX_TIMEOUT_MS,
  agentEvaluateScript,
  agentWaitScript
} from './browser-agent-page/page-wait'

export { agentCursorScript } from './browser-agent-page/page-cursor'
