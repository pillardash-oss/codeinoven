/**
 * The pull request review brief, filled from the pull request being handed over.
 *
 * The wording lives in the editable `pr-review` CIO prompt so a user can decide
 * whether the agent only reports or also fixes what it finds. This module is only
 * the substitution: it takes the resolved template and the facts this review
 * knows, so the renderer never re-implements the template it is rendering.
 */

/** Everything the review brief states about one pull request. */
export interface PrReviewPromptFacts {
  number: number
  title: string
  url: string
  baseRef: string
  remote: string
  /** What the app prepared for this review, as one sentence in the brief. */
  checkout: string
  /** Report file the agent writes its findings to. */
  reportPath: string
}

/**
 * Fill the review template.
 *
 * Unknown tags are left as written, so a user who invents a placeholder sees it
 * rather than silently losing text the prompt was supposed to carry.
 */
export function renderPrReviewPromptTemplate(template: string, facts: PrReviewPromptFacts): string {
  return template
    .replaceAll('{{PR_REF}}', `PR #${facts.number}`)
    .replaceAll('{{PR_TITLE}}', facts.title)
    .replaceAll('{{PR_URL}}', facts.url)
    .replaceAll('{{PR_BASE_REF}}', facts.baseRef)
    .replaceAll('{{PR_REMOTE}}', facts.remote)
    .replaceAll('{{PR_CHECKOUT}}', facts.checkout)
    .replaceAll('{{PR_REPORT_PATH}}', facts.reportPath)
}

/**
 * What the app prepared for this review, in the words the brief uses.
 *
 * A prepared local worktree and a review started from scratch are different
 * instructions: the first names the exact commit already checked out, the second
 * tells the agent to fetch the pull request ref itself.
 */
export function prReviewCheckoutSentence(input: {
  number: number
  preparedHeadCommit: string | null
}): string {
  if (input.preparedHeadCommit) {
    return `The app prepared PR head ${input.preparedHeadCommit} in this thread's local managed worktree scope. Review that exact commit.`
  }
  return `The app did not prepare a review checkout. Fetch refs/pull/${input.number}/head from the PR repository and check it out in an isolated scope before you read anything.`
}
