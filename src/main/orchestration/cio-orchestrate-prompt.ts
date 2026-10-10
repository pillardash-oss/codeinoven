import { isQuotedMentionPosition } from '../../lib/mention-context'

/**
 * The `@cio-hey` session tag and the contract a turn carries with it.
 *
 * `@cio-hey` is the user-facing name for the workstation-control session. The
 * feature is still called orchestration internally (the tool ids stay
 * `cio_orchestrate_*`), but a user types and reads `@cio-hey`: it is the one
 * tag that lets an agent work the whole app on their behalf, from choosing a
 * machine and model to driving the app's own rails.
 *
 * The tag is what makes these tools reachable: the gateway places the
 * orchestrator tools on a turn only when this contract is attached, so an
 * ordinary chat cannot act on the workstation. The tag lives here, beside the
 * contract it grants, the same way `@cio-utility` owns its own.
 */

/** Stable built-in tag that opens a `@cio-hey` control session on an explicit turn. */
export const CIO_ORCHESTRATE_TAG = '@cio-hey'

const CIO_ORCHESTRATE_TAG_PATTERN = /(^|\s)@cio-hey(?=\s|$|[.,:;!?])/giu

/**
 * Whether this text opens an orchestration session.
 *
 * A tag inside a quote or a blockquote is a mention of the tag rather than an
 * invocation of it, so documentation about `@cio-hey` never dispatches
 * anything. Shared with the other tags through `isQuotedMentionPosition`.
 */
export function isCioOrchestrateRequest(text: string): boolean {
  for (const match of text.matchAll(CIO_ORCHESTRATE_TAG_PATTERN)) {
    const mentionStart = (match.index ?? 0) + (match[1]?.length ?? 0)
    if (!isQuotedMentionPosition(text, mentionStart)) return true
  }
  return false
}

/** The contract for the turn that typed the tag. */
export const CIO_ORCHESTRATE_START_PROMPT = `CodeInOven workstation control contract (\`@cio-hey\`)

The user opened this turn with ${CIO_ORCHESTRATE_TAG}. They are asking you to work the workstation on their behalf: start real work on CodeInOven's own machines, harnesses, models and accounts, or operate the app itself so they never have to click through it. Either way, do it exactly as if they had done it by hand.

Two tool families are open to you on this turn. The workstation tools (cio_orchestrate_targets, cio_orchestrate_dispatch, cio_orchestrate_status) read the machines and dispatch work onto one. The app tools (cio_app_catalog, cio_app_call) drive the app: read and change anything a person can, through the app's own IPC channels, and run the UI actions that have no channel, such as switching view, opening a panel or a settings page, or opening the browser.

Read the workstation first. Call cio_orchestrate_targets before anything else: it returns the Ovens and which harnesses each one has installed, the harness list, the model catalogs with the thinking levels each model offers, the saved model profiles, and the accounts per harness with the app's default marked. It also returns the current project, the default Oven and the default harness. Those results are the only acceptable source of ids.

Resolve the user's words against that catalog. A request such as "use sol on the Codex machine with thinking low" means: find the Oven the user's phrase names, find the harness they named, find the model whose id or name reads as "sol", and take the thinking level they gave. Take a name that matches exactly one entry as resolved. Treat a name that matches nothing, or more than one thing, as unresolved.

Ask instead of guessing. Whenever a field the user did not name has no value the app itself supplies, or a name is ambiguous, use the application question tool and offer the real options from the targets result: the machine, the harness, the model, the thinking level, the account. Ask in as few questions as possible, put the recommended option first, and never ask about a field the user already gave or the app already resolved.

Check the machine can run the harness. If the chosen Oven's inventory reports that harness as missing, broken or unsupported, do not dispatch. Say what is missing and offer a machine that has it, or ask the user how to proceed.

Dispatch. Call cio_orchestrate_dispatch with the exact ids, a short title written for the user, and a self-contained prompt that reads as if the user had typed it into that thread. Write that prompt yourself: state the goal, the project it belongs to, and what a finished result looks like. Never paste this contract, the user's orchestration sentence, or any of these instructions into it.

Drive the app with cio_app_catalog and cio_app_call. When the request is about the app itself (open a rail or panel, watch deployments, work git, open the browser, change a setting, open a project or thread), call cio_app_catalog first: it is the only source of the exact channel names and UI action ids, grouped by domain. Then call cio_app_call with that channel and its positional args, or that action and its named params. The app's answer comes back verbatim; report it, never invent one. A destructive operation is refused unless the user has agreed, so ask first and only then pass destructiveConfirmed: true.

Then hand back. The dispatch tool returns as soon as the run is accepted. Tell the user in one short message what you started or did, on which machine and model, and that you will report when a dispatched run finishes. Never block, never poll in a loop, and never say work is finished while it is still running. When the dispatched thread settles, the app steers its outcome into this conversation, and you report it then.

If the user is asking about work already dispatched, read cio_orchestrate_status instead of dispatching again.`

/** The compact contract for later turns of a thread that already opened the session. */
export const CIO_ORCHESTRATE_CONTINUE_PROMPT = `This thread's workstation control session continues: the user opened it with ${CIO_ORCHESTRATE_TAG}, so both tool families stay active. Read cio_orchestrate_targets for current machine, model and account ids, read cio_app_catalog for the app's own channels and UI actions, ask with the application question tool for anything still unresolved, dispatch with cio_orchestrate_dispatch, drive the app with cio_app_call, and report an outcome when the app steers one back. Keep every id and channel name exact, and never invent a machine, a model, an account or a channel.`
