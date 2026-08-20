/** Canonical shared Skills CLI locations. */
export const SHARED_GLOBAL_SKILL_PATH = '~/.agents/skills'
export const SHARED_PROJECT_SKILL_PATH = '.agents/skills'

/** User-level skill locations for the harnesses CodeInOven can drive. */
export const HARNESS_GLOBAL_SKILL_PATHS: Readonly<Record<string, string>> = {
  opencode: '~/.config/opencode/skills',
  codex: '~/.codex/skills',
  'claude-code': '~/.claude/skills',
  pi: '~/.pi/agent/skills',
  cline: '~/.agents/skills',
  antigravity: '~/.gemini/antigravity/skills'
}

export function harnessGlobalSkillPath(harnessId: string): string | undefined {
  return HARNESS_GLOBAL_SKILL_PATHS[harnessId]
}
