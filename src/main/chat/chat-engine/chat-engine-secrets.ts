import { randomUUID } from 'crypto'
import { Logger } from '../../system/logger'
import { validateBoundedString, validateEntityId } from '../../ipc/ipc-validation'
import {
  type AgentSecretResolution,
  type AgentStoredSecret
} from '../../utilities/agent-secret-service'
import type { SecretRequestContext } from '../../utilities/utility-orchestration-service'
import {
  alternativeSecretNames,
  deriveSecretEnvironmentVariable,
  normalizeAgentSecretRequests,
  secretRequestQuestions,
  type AgentSecretPlanEntry
} from '../../../lib/secret-request'
import type { AgentSecretSubmission } from '../../../lib/types'
import type { PendingQuestionInfo } from './chat-engine-types'
import { SECRET_ANSWER_PLACEHOLDER, validateSecretSubmissions } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine secrets: one concern, moved verbatim from the composition root. */
export class ChatEngineSecrets {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Store the secrets a user answered into a `cio_ask_secret` card and settle
   * the gateway tool call that asked for them. Each secret is answered on its
   * own, either with a pasted value or with an instruction that lets the app
   * reuse a value the device already holds, so one card can mix the two. Values
   * never reach the transcript or the model: the card is resolved with a
   * placeholder, and the tool answers with the variable names only.
   */
  async answerSecret(
    projectId: string,
    threadId: string,
    requestId: string,
    secrets: AgentSecretSubmission[]
  ): Promise<void> {
    this.host.units['messages'].touchUserActivity()
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    requestId = validateEntityId(requestId, 'Question request ID', 256)
    const pending = this.host.units['questions'].requirePendingQuestion(
      projectId,
      threadId,
      requestId
    )
    const submissions = validateSecretSubmissions(secrets, pending.request.questions)
    const stored: AgentStoredSecret[] = []
    const unresolved: string[] = []
    const instructions: string[] = []
    for (const submission of submissions) {
      const question = pending.request.questions.find(
        (candidate) => candidate.secretId === submission.secretId
      )
      const environmentVariable = question?.secretEnvironmentVariable
      if (!question || !environmentVariable) continue
      const label = question.header ?? question.prompt
      const utilityId = question.secretUtilityId
      if ('value' in submission) {
        stored.push(
          await this.host.state.agentSecrets.store({
            secretId: submission.secretId,
            environmentVariable,
            value: submission.value,
            label,
            ...(utilityId ? { utilityId } : {}),
            threadId
          })
        )
        continue
      }
      // An instruction instead of a value: the name the user wrote is only a
      // candidate. The value is still adopted under the variable the agent
      // asked for, and a name with nothing stored behind it is reported back so
      // the agent can adapt instead of asking for the same value again.
      const instruction = validateBoundedString(
        submission.alternative,
        'Alternative instruction',
        1,
        20_000
      )
      instructions.push(instruction)
      const reused = await this.host.state.agentSecrets.reuse({
        secretId: submission.secretId,
        environmentVariable,
        label,
        threadId,
        ...(utilityId ? { utilityId } : {}),
        candidateNames: alternativeSecretNames(instruction)
      })
      if (reused) stored.push(reused)
      else unresolved.push(environmentVariable)
    }
    const answers = pending.request.questions.map(() => [SECRET_ANSWER_PLACEHOLDER])
    pending.resumeSecretAfterSettlement = true
    await this.host.units['questions'].resolvePendingQuestion(
      pending,
      'answered',
      answers,
      async () => {
        pending.settleSecret?.({
          status: instructions.length > 0 ? 'alternative' : stored.length > 0 ? 'set' : 'dismissed',
          secrets: stored,
          ...(instructions.length > 0 ? { alternative: instructions.join('\n\n') } : {}),
          ...(unresolved.length > 0 ? { unresolved } : {})
        })
      }
    )
  }

  /**
   * Surface one `cio_ask_secret` card and wait for the user.
   *
   * The request is app-owned, so nothing is sent to a harness: this registers
   * the pending question, broadcasts it, and settles a promise when the card is
   * submitted or dismissed. Storing is deliberately left to `answerSecret`, which
   * is the single deterministic path from a submitted value to vault state.
   */
  async requestUtilitySecrets(
    input: Record<string, unknown>,
    context: SecretRequestContext
  ): Promise<AgentSecretResolution> {
    const requests = normalizeAgentSecretRequests(input)
    const entries: AgentSecretPlanEntry[] = requests.map((request) => {
      const id = randomUUID().replace(/-/gu, '').slice(0, 8).toUpperCase()
      return {
        id,
        title: request.title,
        ...(request.description ? { description: request.description } : {}),
        environmentVariable:
          request.environmentVariable ?? deriveSecretEnvironmentVariable(id, request.title),
        ...(request.utilityId ? { utilityId: request.utilityId } : {})
      }
    })
    const requestId = `cio-secret-${randomUUID()}`
    const pending = this.host.registerPendingQuestion(
      context.harnessId,
      context.projectId,
      context.threadId,
      context.projectPath,
      {
        requestId,
        sessionId: context.sessionId,
        questions: secretRequestQuestions(entries)
      },
      await this.host.units['questions'].pendingQuestionTimeoutMs()
    )
    const settled = new Promise<AgentSecretResolution>((resolve) => {
      pending.settleSecret = resolve
    })
    await this.host.threadManager.setStatus(
      context.projectId,
      context.threadId,
      'awaiting_approval',
      {
        read: false
      }
    )
    this.host.broadcast({
      type: 'question.asked',
      sessionId: context.sessionId,
      requestId,
      questions: pending.request.questions
    })
    const resolution = await settled
    const driver = this.host.units['turns-dispatch'].driverForRuntime(
      context.harnessId,
      this.host.sessionRegistry.get(context.sessionId)?.accountId
    )
    if (
      pending.resumeSecretAfterSettlement &&
      driver &&
      !this.host.units['questions-ask'].questionAnswerCanReachLiveTurn(pending, driver)
    ) {
      await this.resumeAfterInactiveSecretRequest(pending, resolution)
    }
    return resolution
  }

  /** Resume the thread when a secret card settles after its Codex turn ended. */
  async resumeAfterInactiveSecretRequest(
    pending: PendingQuestionInfo,
    resolution: AgentSecretResolution
  ): Promise<void> {
    await this.host.units['turns-sessions'].awaitInactiveResumeIdleFinalization(pending)
    await this.host.units['questions']
      .settleUnresumableQuestionTurn(pending.request.sessionId)
      .catch((error: unknown) => Logger.error('Secret request turn settlement failed:', error))

    const thread = await this.host.threadManager.getThread(
      pending.request.projectId,
      pending.request.threadId
    )
    if (!thread?.settings) {
      throw new Error(`Thread settings are unavailable: ${pending.request.threadId}`)
    }

    const secretReferences = resolution.secrets.map((secret) => ({
      environmentVariable: secret.environmentVariable,
      ...(secret.boundUtilityId ? { boundUtilityId: secret.boundUtilityId } : {}),
      ...(secret.reusedFrom ? { reusedFrom: secret.reusedFrom } : {})
    }))
    const prompt = [
      'Your previous turn ended while waiting for the user to resolve a secret request.',
      resolution.status === 'dismissed'
        ? 'The user dismissed the request. Continue without those secrets, and ask again only if one is essential.'
        : resolution.status === 'alternative'
          ? 'The user answered with an alternative. Its free text is omitted here to keep this prompt free of possible secret values. Use the available references below, adapt around unresolved names, and do not ask for resolved secrets again.'
          : 'The user resolved the request. Secret values remain in the encrypted vault and are not included here. Use the available references below, never print or expose their values, and do not ask for resolved secrets again.',
      JSON.stringify({
        status: resolution.status,
        secrets: secretReferences,
        ...(resolution.unresolved ? { unresolvedEnvironmentVariables: resolution.unresolved } : {})
      })
    ].join('\n\n')
    await this.host.sendPrompt(
      pending.request.projectId,
      pending.request.threadId,
      thread.settings,
      prompt,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'internal'
    )
  }
}
