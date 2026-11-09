/**
 * The message a dispatch sends its dispatcher when work stops on a human.
 *
 * A dispatched thread reports routine outcomes back into the conversation that
 * started it, and it never notifies the user directly. The one thing a report
 * cannot carry is a decision: a question, a secret, or a permission the thread
 * cannot answer for itself. Those are the moments the whole chain has to reach a
 * person, so the thread that dispatched the work is told what is blocked, and it
 * is the dispatcher that puts the card in front of the user, under a label naming
 * the thread it belongs to.
 *
 * Kept here, as prose, for the same reason every other app-owned instruction is:
 * the wording is a contract between two agents, not a detail of one handler.
 */

/** The three things that stop a dispatched thread until a person decides. */
export type DelegatedAttentionKind = 'question' | 'secret' | 'permission'

/** One blocked thread, as its dispatcher is told about it. */
export interface DelegatedAttentionRequest {
  kind: DelegatedAttentionKind
  /** Thread that dispatched the blocked work, and where this prompt is going. */
  dispatcherProjectId: string
  dispatcherThreadId: string
  /** The blocked thread. */
  projectId: string
  threadId: string
  threadTitle: string
  /** The pending request's own id, which the answer is submitted against. */
  requestId: string
  /** What the blocked thread is asking, ready to be shown or restated. */
  detail: string
}

/** What each kind needs back, in one line, for the dispatcher. */
const ANSWER_CONTRACT: Readonly<Record<DelegatedAttentionKind, string>> = {
  question: [
    'Ask the user this question yourself, here, with your question tool: one card, the same choices the blocked thread offered, and the thread it comes from named in the card. Then call cio_orchestrate_answer with kind "question" and `answers`, one entry per question in the order below, exactly as the user answered them.'
  ].join(''),
  secret: [
    'Collect the value yourself with cio_ask_secret, so it lands in the device vault and never in either conversation. Then call cio_orchestrate_answer with kind "secret" and `secrets`, one entry per secret below, carrying its `secretId` and the `environmentVariable` you collected it under. Never paste the value here, never ask for it in chat, and never read it back.'
  ].join(''),
  permission: [
    'Ask the user whether to allow it, here, naming the thread it comes from, and offer allow once, allow always and deny. Then call cio_orchestrate_answer with kind "permission" and `permission` set to "once", "always" or "reject".'
  ].join('')
}

/**
 * The instruction the dispatcher receives for one blocked thread.
 *
 * It says three things in order: which thread stopped, what it needs, and exactly
 * how to hand the answer back. It also says what not to do, because the two
 * failure modes are both tempting: answering on the user's behalf, and telling the
 * user to go and open the other thread instead of asking them here.
 */
export function buildDelegatedAttentionPrompt(request: DelegatedAttentionRequest): string {
  const kindLabel =
    request.kind === 'secret'
      ? 'a secret'
      : request.kind === 'permission'
        ? 'a permission'
        : 'an answer'
  return [
    `A thread you dispatched has stopped and needs ${kindLabel} from the user before it can continue.`,
    `The thread is "${request.threadTitle}" (thread ${request.threadId} in project ${request.projectId}, request ${request.requestId}).`,
    `What it needs: ${request.detail}`,
    'It cannot wait for the user to go and find it: a dispatched thread never notifies the user, so this conversation is where the decision happens.',
    ANSWER_CONTRACT[request.kind],
    'Ask the user here, in this conversation, and name the thread in the card so they know which work they are deciding for. Never answer for them, never guess a value, and never tell them to open the other thread and answer it there.',
    'When the answer is accepted the blocked thread continues on its own and reports its outcome back into this conversation. Say nothing more about it until then.'
  ].join('\n')
}

/**
 * What a blocked thread is asking, written out for the agent that has to ask the
 * user in its own conversation.
 *
 * The dispatcher restates the card rather than forwarding a raw payload: it is a
 * conversation, and a person reading it should see the question, its choices and
 * the secret labels exactly as they were asked.
 */
export function delegatedQuestionDetail(
  questions: readonly {
    prompt: string
    header?: string
    options?: readonly string[]
    richOptions?: readonly { label: string }[]
    multiple?: boolean
    secretRequest?: boolean
    secretId?: string
    secretEnvironmentVariable?: string
  }[]
): string {
  const lines = questions.map((question, index) => {
    const choices = question.richOptions?.length
      ? question.richOptions.map((option) => option.label)
      : (question.options ?? [])
    const parts = [
      `${index + 1}. ${question.header ? `${question.header}: ` : ''}${question.prompt}`
    ]
    if (question.secretRequest) {
      parts.push(
        `   It is a secret, stored under ${question.secretEnvironmentVariable ?? 'a variable'} (secretId ${question.secretId ?? 'unknown'}).`
      )
    }
    if (choices.length > 0) {
      parts.push(
        `   Choices: ${choices.join(' | ')}${question.multiple ? ' (several may be chosen)' : ''}`
      )
    }
    return parts.join('\n')
  })
  return lines.join('\n')
}

/** The one-line summary a report uses to name the blocked thread. */
export function delegatedAttentionLabel(
  request: Pick<DelegatedAttentionRequest, 'threadTitle'>
): string {
  return request.threadTitle.trim() || 'A thread you dispatched'
}
