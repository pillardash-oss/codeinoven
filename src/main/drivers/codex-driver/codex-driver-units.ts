import type { CodexDriver } from '../codex-driver'
import { CodexDriverCatalog } from './codex-driver-catalog'
import { CodexDriverPrompting } from './codex-driver-prompting'
import { CodexDriverCapabilities } from './codex-driver-capabilities'
import { CodexDriverTitle } from './codex-driver-title'
import { CodexDriverUsage } from './codex-driver-usage'
import { CodexDriverTurns } from './codex-driver-turns'
import { CodexDriverTools } from './codex-driver-tools'
import { CodexDriverDriver } from './codex-driver-driver'
import { CodexDriverPanels } from './codex-driver-panels'
import { CodexDriverApprovals } from './codex-driver-approvals'
import { CodexDriverQuestions } from './codex-driver-questions'
import { CodexDriverSessions } from './codex-driver-sessions'
import { CodexDriverRuntime } from './codex-driver-runtime'
import { CodexDriverProtocol } from './codex-driver-protocol'
import { CodexDriverMessages } from './codex-driver-messages'

/** The concern units a CodexDriver delegates to, built once in its constructor. */
export function buildCodexDriverUnits(engine: CodexDriver) {
  return {
    catalog: new CodexDriverCatalog(engine, engine.base),
    prompting: new CodexDriverPrompting(engine, engine.base),
    capabilities: new CodexDriverCapabilities(engine, engine.base),
    title: new CodexDriverTitle(engine, engine.base),
    usage: new CodexDriverUsage(engine, engine.base),
    turns: new CodexDriverTurns(engine, engine.base),
    tools: new CodexDriverTools(engine, engine.base),
    driver: new CodexDriverDriver(engine, engine.base),
    panels: new CodexDriverPanels(engine, engine.base),
    approvals: new CodexDriverApprovals(engine, engine.base),
    questions: new CodexDriverQuestions(engine, engine.base),
    sessions: new CodexDriverSessions(engine, engine.base),
    runtime: new CodexDriverRuntime(engine, engine.base),
    protocol: new CodexDriverProtocol(engine, engine.base),
    messages: new CodexDriverMessages(engine, engine.base)
  } as const
}

export type CodexDriverUnits = ReturnType<typeof buildCodexDriverUnits>
