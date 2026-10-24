/**
 * The Cua Driver capability contract, handed to an agent the moment it activates
 * the app-owned computer-use utility.
 *
 * A driver tool catalog is a list of single actions, and an agent handed only
 * that catalog drives a desktop one round trip per keystroke: each `cio_util_use`
 * is a separate model step, so a form that should take one call takes a dozen.
 * The driver already ships the two batching verbs that fix this (`run_script` and
 * `run_steps`), and this is the paragraph that says so before the agent starts.
 *
 * Written as the app's own voice: a capability contract, not a tutorial.
 */
export const CUA_PLAYBOOK = [
  'Cua Driver drives the real desktop on this machine through one app-owned cursor session.',
  '',
  '## Act in one call',
  '- `run_script` runs a JavaScript program against the driver: loop, branch, read state between actions, return only the result.',
  '- `run_steps` runs an ordered list of action tools in one call, stops at the first failure, and reports what changed when you ask for `observe`.',
  '- Batch every action one task needs into one of those calls. A gateway invocation per keystroke, per field, or per click is the failure mode here: each `cio_util_use` is its own model step and its own round trip.',
  '- When the remaining work genuinely depends on what you just saw, act, read, then act again in as few round trips as possible.',
  '',
  '## Observe on purpose',
  '- `list_apps` and `list_windows` give you the `pid` and `window_id` once. Reuse them for the whole task instead of rediscovering the window every step.',
  '- Re-read state (`get_app_state`, `get_window_state`) only when the next action depends on it, and ask for a screenshot only when you must see pixels. The accessibility text is cheaper and usually enough.',
  '- A read that changed nothing is a wasted step. Read after a batch, not between every action.',
  '',
  '## The catalog',
  '- The tools below are the driver itself. Prefer the two batching verbs over chains of single-action tools.',
  '- A large catalog arrives as an index of names, descriptions and input signatures; call the tools with those fields rather than guessing, and a rejected argument names the field it wanted.',
  '',
  '## Session ownership',
  '- The app owns the cursor session: reuse it. Never start `cua-driver` through a shell, never start your own session, and never invent a session name.',
  '- Background delivery first. Use foreground delivery for the action that requires it, then return to background.',
  '',
  '## Report what happened',
  '- Read the state back after a batch, and report what changed, not what you intended to change.',
  '- If the driver refuses an action, say which action and what the driver reported; never claim a change you did not verify.'
].join('\n')
