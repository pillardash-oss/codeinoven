import { type TitleModelCandidate } from '../persistent-cli-driver'
import type { CodexDriver } from '../codex-driver'

/** CodexDriver title: one concern, moved verbatim from the composition root. */
export class CodexDriverTitle {
  constructor(
    private readonly host: CodexDriver,
    private readonly base: CodexDriver['base']
  ) {}

  /** Luna is Codex's single cheap auxiliary candidate. */
  async cheapestCandidate(_projectPath: string): Promise<TitleModelCandidate[]> {
    void _projectPath
    return [{ providerId: 'openai', modelId: 'gpt-5.6-luna' }]
  }
}
