import type { IdeLanguageServer } from './ide-language-servers'

/**
 * What a "set up with agent" draft asks for.
 *
 * The agent is the one who knows the language server landscape, the user is the
 * one who knows which language they actually want, so the draft opens a
 * conversation instead of handing over a specification: the agent asks first,
 * proposes the options it can install or find, and only configures the server
 * the user picked.
 */

/** The import shape the IDE Mode settings page accepts, shared by every draft. */
const IMPORT_CONTRACT = `End your work with a JSON array I can paste into Settings > IDE Mode > Import. Each entry has id, name, enabled, command (executable only), args (string array), languages ([{extension: '.go', languageId: 'go'}]), env (string record, inherited variables referenced as \${NAME}), rootMarkers (file or directory names that locate the project root), initializationOptions (object) and settings (object). Return only the new or modified entries, keep one enabled server per extension, put credentials in environment variables, and do not enable IDE Mode or write configuration into project source.`

/** A short inventory so the agent extends the existing setup instead of duplicating it. */
function inventory(servers: readonly IdeLanguageServer[]): string {
  return `Language servers already configured: ${JSON.stringify(
    servers.map((server) => ({
      id: server.id,
      name: server.name,
      command: server.command,
      extensions: server.languages.slice(0, 12).map((mapping) => mapping.extension)
    }))
  )}`
}

/**
 * A draft that starts from the user's intent.
 *
 * Nothing is preselected here, so the question the agent asks comes first: which
 * language or language server does the user want. Everything after that is work
 * the agent does once it has an answer.
 */
export function ideSetupRequest(servers: readonly IdeLanguageServer[]): string {
  return [
    'Help me set up a language server for IDE Mode.',
    'Ask me which language or language server I want before you configure anything: inspect this project and offer the options that make sense for it, including the servers you can install for me and any you would recommend I install myself. Then wait for my answer, and ask again before adding a second server.',
    'Once I pick one, check whether it is already installed here or configured in another editor I use, install it if it is missing (into the app or system tool locations, never into the project), and confirm with me that navigation works before you finish.',
    IMPORT_CONTRACT,
    inventory(servers)
  ].join('\n\n')
}

/**
 * The same conversation for one server the user pointed at.
 *
 * The choice of server is already made, so the draft skips straight to the
 * questions that decision still leaves open, and the preset is offered as a
 * starting point rather than as a decision the user cannot revisit.
 */
export function ideServerSetupRequest(
  server: IdeLanguageServer,
  servers: readonly IdeLanguageServer[]
): string {
  const extensions = server.languages.map((mapping) => mapping.extension).join(', ')
  const executable = [server.command, ...server.args].join(' ').trim()
  return [
    `Help me set up ${server.name} for IDE Mode.`,
    `The preset I picked runs ${executable} for ${extensions}. Ask me what you still need to know before configuring it, and wait for my answer: whether I want this server or a better fit for the language, whether it is already installed, and how I want it installed if it is not. Do not guess.`,
    `Then install it (into the app or system tool locations, never into the project), replace the preset if I choose something else, and confirm with me that navigation works before you finish.`,
    IMPORT_CONTRACT,
    inventory(servers)
  ].join('\n\n')
}
