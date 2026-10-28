/**
 * What the "set up with agent" buttons seed into a conversation.
 *
 * The agent is the one who knows the language server landscape, the user is the
 * one who knows which language they care about, and the app is the thing that
 * has to end up configured. So the draft is one sentence of intent plus the
 * steps that make the setup real: ask, install, write the configuration through
 * the app's own IPC, then prove navigation works. Nothing here asks the user to
 * carry a configuration back into Settings by hand, and nothing states what the
 * agent can read for itself   the current servers come from `config:get`, the
 * project's languages from the project.
 */

/** The request the user sends, kept as the sentence they would type themselves. */
const SETUP_GOAL =
  'I want to set up an LSP for CIO so I can use it to edit files in IDE Mode. Ask me the LSP I want and set it up for me after I have given you an answer.'

/** How the setup is actually completed, shared by both entry points. */
const SETUP_WORK = `Set it up so it works when we are done, in this conversation, rather than handing me a configuration to import myself. You can read and change the app's own settings on this turn through cio_app_catalog and cio_app_call.

1. Ask first: offer the language servers that fit this project, say which ones you can install yourself, and wait for my answer before configuring anything. Ask again before adding a second server.
2. Write the configuration yourself: call the config:get channel, then the config:update channel with ideLanguageServers, merging into the servers already configured rather than replacing them. Each entry is { id, name, enabled, command, args, languages: [{ extension, languageId }], env, rootMarkers, initializationOptions, settings }, where ids are unique letters, numbers or dashes, every extension starts with a dot, and several enabled servers may cover the same extension because IDE Mode runs every server that matches a file (structure plus Tailwind class completion, for example).
3. Get the executable onto this machine: when the app can install the server itself, call the projectFiles:ide channel with this project's id and { owner: 'agent-setup', action: 'install', path: '', serverId }; otherwise install it with the toolchains this machine already has and give its absolute path if it will not resolve on PATH.
4. Prove it works: call the projectFiles:ide channel with this project's id and { owner: 'agent-setup', action: 'check', path: '', serverId } and tell me what it reported. Fix what fails before calling the setup done.

Do not enable IDE Mode for me and do not write any of this configuration into project source.`

/** Nothing is preselected here, so the question the agent asks comes first. */
export function ideSetupRequest(): string {
  return [SETUP_GOAL, SETUP_WORK].join('\n\n')
}

/**
 * The same conversation for one server the user pointed at.
 *
 * Only the name travels with the draft: everything about that server lives in
 * IDE Mode's configuration, which the agent reads before it changes anything.
 */
export function ideServerSetupRequest(serverName: string): string {
  return [
    `I want to set up ${serverName} for CIO so I can use it to edit files in IDE Mode. Ask me what you need to know, then set it up for me after I have given you an answer.`,
    SETUP_WORK
  ].join('\n\n')
}
