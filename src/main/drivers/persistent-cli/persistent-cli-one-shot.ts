import { Logger } from '../../system/logger'
import type { GenerateTitleOptions, SendPromptOptions } from '../driver.interface'
import type {
  OneShotOutcome,
  PersistentCliSession,
  TitleAttemptAccounting,
  TitleModelCandidate
} from './persistent-cli-types'
import {
  buildTitleAttempt,
  describeTitleFailure,
  TITLE_GENERATION_TIMEOUT_MS,
  TitleTurnProviderIssueError,
  type TitleTurnRegistry
} from './persistent-cli-title'

/** Driver callbacks an auxiliary one-shot run needs from its owner. */
export interface OneShotHost {
  driverName: string
  titleTurns: TitleTurnRegistry
  createSession: (projectPath: string, title: string) => Promise<string>
  sendPrompt: (projectPath: string, options: SendPromptOptions) => Promise<void>
  requireSession: (projectPath: string, sessionId: string) => Promise<PersistentCliSession>
  abort: (projectPath: string, sessionId: string) => Promise<void>
  deleteSession: (projectPath: string, sessionId: string) => Promise<void>
}

/** Run one auxiliary one-shot completion per disposable session, cheapest candidate first. */
export async function runOneShotWithCandidates(
  host: OneShotHost,
  projectPath: string,
  options: GenerateTitleOptions,
  candidates: TitleModelCandidate[],
  promptText: string,
  validate: (raw: string) => string | null,
  timeoutMs: number = TITLE_GENERATION_TIMEOUT_MS
): Promise<OneShotOutcome> {
  const fallback = {
    providerId: options.settings.providerId,
    modelId: options.settings.modelId
  }
  const attempts = [...candidates, fallback].filter(
    (candidate, index, all) =>
      Boolean(candidate.providerId && candidate.modelId) &&
      all.findIndex(
        (other) => other.providerId === candidate.providerId && other.modelId === candidate.modelId
      ) === index
  )
  const accounted: TitleAttemptAccounting[] = []

  for (let index = 0; index < attempts.length; index++) {
    const candidate = attempts[index]
    const sessionId = await host.createSession(projectPath, 'Auxiliary one-shot')
    host.titleTurns.register(sessionId)
    const completion = host.titleTurns.wait(sessionId, host.driverName, timeoutMs)
    try {
      await host.sendPrompt(projectPath, {
        sessionId,
        settings: {
          ...options.settings,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          thinkingLevel: 'minimal',
          inferenceMode: 'normal',
          permissionLevel: 'auto_review'
        },
        text: promptText,
        attachments: [],
        readOnly: true,
        allowedTools: []
      })
      await completion.promise
      // Read the live session record directly: a driver override may answer
      // from a native transcript or report [] for unresumable sessions, while
      // title generation always wants this disposable session's own mirror.
      const titleSession = await host.requireSession(projectPath, sessionId)
      const messages = titleSession.messages
      const response = [...messages].reverse().find((message) => message.role === 'assistant')
      if (response?.error) {
        // Surface the CLI's own failure text; without this the reason behind
        // a null score (session limit, auth, transport) is unrecoverable.
        Logger.dev(
          `${host.driverName} one-shot model ${candidate.providerId}/${candidate.modelId} failed: ${response.error}`
        )
        accounted.push(buildTitleAttempt(index + 1, candidate, false, response.error, response))
        continue
      }
      const raw = response?.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
      const value = raw ? validate(raw) : null
      if (value !== null) {
        accounted.push(buildTitleAttempt(index + 1, candidate, true, null, response))
        return { value, authFailed: false, attempts: accounted }
      }
      Logger.dev(
        `${host.driverName} one-shot model ${candidate.providerId}/${candidate.modelId} produced no usable response`,
        raw ? raw.slice(0, 300) : '(empty response)'
      )
      accounted.push(
        buildTitleAttempt(index + 1, candidate, false, 'No usable response produced', response)
      )
    } catch (error) {
      const fallbackReason = describeTitleFailure(error)
      if (error instanceof TitleTurnProviderIssueError && error.issue.kind === 'authentication') {
        accounted.push(buildTitleAttempt(index + 1, candidate, false, fallbackReason))
        if (index === attempts.length - 1) {
          return { value: null, authFailed: true, attempts: accounted }
        }
        continue
      }
      Logger.dev(
        `${host.driverName} one-shot model ${candidate.providerId}/${candidate.modelId} unavailable:`,
        error
      )
      accounted.push(buildTitleAttempt(index + 1, candidate, false, fallbackReason))
    } finally {
      completion.cancel()
      await host.abort(projectPath, sessionId).catch(() => undefined)
      await host.deleteSession(projectPath, sessionId).catch(() => undefined)
      host.titleTurns.unregister(sessionId)
    }
  }
  return { value: null, authFailed: false, attempts: accounted }
}
