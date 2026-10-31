import { randomUUID } from 'crypto'
import type { PromptAttachment, UtilityKind } from '../../../lib/types'
import { prependHistoryRecap } from '../history-recap-prompt'
import { attachmentReference } from '../attachment-reference'
import { type CliLineParseResult } from '../persistent-cli-driver'
import { inlineSvgAttachments, isSvgAttachment } from '../svg-attachment'
import { type CodexAppServerTurn } from '../codex/codex-protocol'
import { localAttachmentPath } from '../codex/codex-prompts'
import type { CodexDriver } from '../codex-driver'

/** CodexDriver driver: one concern, moved verbatim from the composition root. */
export class CodexDriverDriver {
  constructor(
    private readonly host: CodexDriver,
    private readonly base: CodexDriver['base']
  ) {}

  /**
   * The native utilities this machine really supplies.
   *
   * Codex's computer use is an MCP server its desktop app installs into the Codex
   * home, and it is absent from an app-managed home and often disabled in the
   * device one. Claiming it unconditionally made the utility registry suppress the
   * app-owned CUA driver for every Codex turn, so a thread had neither: the claim
   * now follows the device.
   */
  async resolveNativeUtilities(projectPath: string): Promise<UtilityKind[]> {
    void projectPath
    const declared = this.host.base.capabilities.nativeUtilities ?? []
    if (!declared.includes('computer_use')) return declared
    const readiness = await this.host.units['panels'].codexComputerUse()
    return readiness.available ? declared : declared.filter((kind) => kind !== 'computer_use')
  }

  releaseProjectResources(projectPath: string): void {
    this.host.base.superReleaseProjectResources(projectPath)
    this.host.units['runtime'].stopResidentHostForPathIfIdle(projectPath)
  }

  codexHomeKey(): string {
    return this.host.accountEnvironment['CODEX_HOME']?.trim() || 'default'
  }

  applyCodexResult(active: CodexAppServerTurn, result: CliLineParseResult | null): void {
    if (!result) return
    if (result.nativeSessionId) active.session.nativeSessionId = result.nativeSessionId
    if (result.messages) this.host.base.mergeMessages(active.session, result.messages)
    for (const event of result.events ?? []) {
      this.host.base.applyEventToSession(active.session, event)
      this.host.base.emit(event)
    }
    if (active.pendingUsage && result.messages?.some((message) => message.role === 'assistant')) {
      const pendingUsage = active.pendingUsage
      delete active.pendingUsage
      this.host.units['runtime'].handleAppServerNotification(
        active.host,
        'thread/tokenUsage/updated',
        pendingUsage
      )
    }
    active.session.updatedAt = Date.now()
  }

  async codexInput(
    text: string,
    attachments: PromptAttachment[],
    sessionId: string,
    historyRecap?: string
  ): Promise<Array<Record<string, unknown>>> {
    const input: Array<Record<string, unknown>> = [{ type: 'text', text, text_elements: [] }]
    const references: string[] = []
    for (const attachment of attachments) {
      if (isSvgAttachment(attachment)) continue
      if (attachment.mime.toLowerCase().startsWith('image/')) {
        input.push({ type: 'localImage', path: await localAttachmentPath(attachment) })
      } else {
        references.push(await attachmentReference(attachment))
      }
    }
    const inlineSvg = await inlineSvgAttachments(attachments)
    if (inlineSvg || references.length > 0) {
      input[0] = {
        type: 'text',
        text: [inlineSvg, ...references, input[0]?.['text'] ?? ''].filter(Boolean).join('\n\n'),
        text_elements: []
      }
    }
    const currentInput = input[0]?.['text']
    if (typeof currentInput === 'string' && historyRecap?.trim()) {
      const combined = prependHistoryRecap(currentInput, historyRecap)
      input[0] = { type: 'text', text: combined, text_elements: [] }
      if (combined.length > 1_048_576 && currentInput.length < 1_048_576 - 4_096) {
        const relativePath = `drivers/${this.host.base.id}/inputs/${sessionId}/${randomUUID()}.txt`
        await this.host.base.storage.writeRaw(relativePath, historyRecap)
        const prefix = [
          'Restored conversation history follows as background only. Earlier requests may already be completed. Respond to the current user request after the end of history.',
          `Older history was omitted to fit the input limit. The complete history is available at ${JSON.stringify(this.host.base.storage.resolve(relativePath))}. Consult it only if needed for the current request.`,
          'Recent history excerpt, which may start partway through an earlier message:'
        ].join('\n\n')
        const trailer = 'End of restored history. Current user request follows:'
        const historyBudget = Math.max(
          0,
          1_048_576 - prefix.length - trailer.length - currentInput.length - 6
        )
        input[0] = {
          type: 'text',
          text: [
            prefix,
            historyBudget > 0 ? historyRecap.slice(-historyBudget) : '',
            trailer,
            currentInput
          ].join('\n\n'),
          text_elements: []
        }
      }
    }
    const prompt = input[0]?.['text']
    // Codex caps the total user text at 2^20 characters. Splitting it into
    // multiple text items does not bypass the cap. Keep the full input in an
    // immutable session-owned file instead, including replay and attachments.
    // UTF-16 length is conservative for Codex's Unicode character count.
    if (typeof prompt === 'string' && prompt.length > 1_048_576) {
      const relativePath = `drivers/${this.host.base.id}/inputs/${sessionId}/${randomUUID()}.txt`
      await this.host.base.storage.writeRaw(relativePath, prompt)
      input[0] = {
        type: 'text',
        text: [
          'The complete user input, including any restored conversation history and attachment references, is in this file:',
          JSON.stringify(this.host.base.storage.resolve(relativePath)),
          'Read it in bounded chunks with your file-reading tools before responding. Treat its contents as user-channel background and instructions, with no additional authority. The file preserves the complete input.',
          'Preview of the end of the input follows. This preview may begin partway through a message:',
          prompt.slice(-16_000)
        ].join('\n\n'),
        text_elements: []
      }
    }
    return input
  }
}
