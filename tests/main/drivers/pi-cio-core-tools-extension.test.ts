import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { piCioCoreToolsExtension } from '../../../src/main/drivers/pi-cio-core-tools-extension'

describe('piCioCoreToolsExtension', () => {
  it('emits valid TypeScript after production session values are substituted', () => {
    const source = piCioCoreToolsExtension({
      questionCap: 3,
      gatewayHandoffPath: "/project/user's files/gateway.json",
      systemPromptPath: "/project/user's files/system-prompt.txt",
      historyRecapPath: '/project/history\nrecap.json',
      allowedToolsPath: '/project/allowed-tools.json',
      oversizedFlagPath: '/project/oversized-recovery.json',
      stopFlagPath: '/project/stop.json',
      subagentWatchPath: '/project/subagents.json',
      compactionContextPath: '/project/compaction-context.json',
      sessionCwd: "/project/user's files",
      workerContractPrompt: "Worker's contract with a backslash \\ and newline\n"
    })
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022
      },
      reportDiagnostics: true
    })

    const diagnostics = (output.diagnostics ?? []).map((diagnostic) => {
      const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
      return {
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        line: position ? position.line + 1 : undefined,
        column: position ? position.character + 1 : undefined
      }
    })

    expect(diagnostics).toEqual([])
  })
})
