import { isQuotedMentionPosition } from '../../lib/mention-context'

/**
 * The `@cio-orchestrate` session tag and the contract a turn carries with it.
 *
 * The tag is what makes the workstation tools reachable: the gateway places
 * `cio_orchestrate_targets`, `cio_orchestrate_dispatch` and
 * `cio_orchestrate_status` on a turn only when this contract is attached, so an
 * ordinary chat cannot dispatch work onto a machine. The tag itself lives here,
 * beside the contract it grants, the same way `@cio-utility` owns its own.
 */

/** Stable built-in tag that opens an orchestration session on an explicit turn. */
export const CIO_ORCHESTRATE_TAG = '@cio-orchestrate'

const CIO_ORCHESTRATE_TAG_PATTERN = /(^|\s)@cio-orchestrate(?=\s|$|[.,:;!?])/giu

/**
 * Whether this text opens an orchestration session.
 *
 * A tag inside a quote or a blockquote is a mention of the tag rather than an
 * invocation of it, so documentation about `@cio-orchestrate` never dispatches
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
export const CIO_ORCHESTRATE_START_PROMPT = `CodeInOven orchestration contract

The user opened this turn with ${CIO_ORCHESTRATE_TAG}. They are asking you to set up and start real work on the workstation, using CodeInOven's own machines, harnesses, models and accounts, exactly as if they had chosen those settings and started the thread themselves.

Read the workstation first. Call cio_orchestrate_targets before anything else: it returns the Ovens and which harnesses each one has installed, the harness list, the model catalogs with the thinking levels each model offers, the saved model profiles, and the accounts per harness with the app's default marked. It also returns the current project, the default Oven and the default harness. Those results are the only acceptable source of ids.

Resolve the user's words against that catalog. A request such as "use sol on the Codex machine with thinking low" means: find the Oven the user's phrase names, find the harness they named, find the model whose id or name reads as "sol", and take the thinking level they gave. Take a name that matches exactly one entry as resolved. Treat a name that matches nothing, or more than one thing, as unresolved.

Ask instead of guessing. Whenever a field the user did not name has no value the app itself supplies, or a name is ambiguous, use the application question tool and offer the real options from the targets result: the machine, the harness, the model, the thinking level, the account. Ask in as few questions as possible, put the recommended option first, and never ask about a field the user already gave or the app already resolved.

Check the machine can run the harness. If the chosen Oven's inventory reports that harness as missing, broken or unsupported, do not dispatch. Say what is missing and offer a machine that has it, or ask the user how to proceed.

Dispatch. Call cio_orchestrate_dispatch with the exact ids, a short title written for the user, and a self-contained prompt that reads as if the user had typed it into that thread. Write that prompt yourself: state the goal, the project it belongs to, and what a finished result looks like. Never paste this contract, the user's orchestration sentence, or any of these instructions into it.

Then hand back. The tool returns as soon as the run is accepted. Tell the user in one short message what you started, on which machine and model, and that you will report when it finishes. Never block, never poll in a loop, and never say work is finished while it is still running. When the dispatched thread settles, the app steers its outcome into this conversation, and you report it then.

If the user is asking about work already dispatched, read cio_orchestrate_status instead of dispatching again.`

/** The compact contract for later turns of a thread that already opened the session. */
export const CIO_ORCHESTRATE_CONTINUE_PROMPT = `This thread's orchestration session continues: the user opened it with ${CIO_ORCHESTRATE_TAG}, so the workstation tools stay active. Read cio_orchestrate_targets when you need current ids, ask with the application question tool for anything still unresolved, dispatch with cio_orchestrate_dispatch, and report an outcome when the app steers one back. Keep every id exact and never invent a machine, a model or an account.`
