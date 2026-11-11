/**
 * What the Utilities page says about each built-in capability.
 *
 * A built-in's registry description is written for agents: it tells a model
 * when to reach for the tool and what to avoid. That brief is the wrong copy for
 * the person reading Settings, so the page shows these summaries instead and
 * keeps the agent brief out of the UI. Search still matches the full brief.
 */
const BUILT_IN_UTILITY_SUMMARIES: Readonly<Record<string, string>> = {
  'cio:see-image':
    'Describes images so models that cannot see can still work with screenshots and media.',
  'cio:browser': 'The in-app browser agents use to open, test and interact with web pages.',
  'cio:cua-driver': 'Lets agents use desktop apps through Cua Driver.',
  'cio:scope': 'Creates and manages Git worktree scopes for a project, shown on the board.',
  'cio:adb': 'Guides agents driving an Android device or emulator over adb.',
  'cio:design': 'Designs screens as HTML and previews them in the design panel.',
  'cio:video': 'Builds video compositions and exports them.',
  'cio:artifact': 'Shows generated images, audio, HTML and SVG inline in the conversation.',
  'cio:cite-report': 'Adds an open card for each report or document a turn produced.',
  'cio:follow-up': 'Wakes a thread at a time you agreed to, when it is waiting on someone else.'
}

/** The user-facing summary for a built-in utility, or null for any other utility. */
export function builtInUtilitySummary(utilityId: string): string | null {
  return BUILT_IN_UTILITY_SUMMARIES[utilityId] ?? null
}
