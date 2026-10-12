import { describe, expect, it } from 'vitest'
import {
  WINDOWS_LAUNCHER_FILE,
  WINDOWS_TASK_NAME,
  disableTaskArgs,
  enableTaskArgs,
  registerTaskArgs,
  runTaskArgs,
  windowsLauncherScript,
  windowsTaskAction
} from '../../../src/main/ovens/remote/oven-windows-task'

const input = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  servicePath: 'C:\\Users\\dev\\.config\\pillardash\\codeinoven\\ovens\\service.mjs',
  dataRoot: 'C:\\Users\\dev\\.config\\pillardash\\codeinoven\\ovens',
  revision: 'abc123'
}

describe('windows Oven launcher', () => {
  it('starts node hidden, through a host that has no console of its own', () => {
    const script = windowsLauncherScript(input)
    // Window style 0 is the whole point: node must not open a console.
    expect(script).toContain(', 0, False')
    expect(script).toContain('WScript.Shell')
    // The executable and the script are quoted inside the command line, so a
    // path with a space still resolves. VBScript doubles each inner quote.
    expect(script).toContain(
      '"""C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\dev\\.config\\pillardash\\codeinoven\\ovens\\service.mjs"" daemon"'
    )
  })

  it('carries the data root, the revision, and the shipped Node on PATH', () => {
    const script = windowsLauncherScript(input)
    expect(script).toContain(
      '"CODEINOVEN_OVEN_DATA_ROOT") = "C:\\Users\\dev\\.config\\pillardash\\codeinoven\\ovens"'
    )
    expect(script).toContain('"CODEINOVEN_OVEN_REVISION") = "abc123"')
    expect(script).toContain('= "C:\\Program Files\\nodejs;" &')
  })

  it('omits the revision when none was given, so a dev run is unchanged', () => {
    const script = windowsLauncherScript({ ...input, revision: undefined })
    expect(script).not.toContain('CODEINOVEN_OVEN_REVISION')
    expect(script).toContain('CODEINOVEN_OVEN_DATA_ROOT')
  })

  it('names one task and one launcher every path agrees on', () => {
    expect(WINDOWS_TASK_NAME).toBe('CodeInOven Oven')
    expect(WINDOWS_LAUNCHER_FILE).toBe('service-launch.vbs')
  })
})

describe('windows Oven task commands', () => {
  it('registers a logon task whose action is the hidden launcher', () => {
    const args = registerTaskArgs('C:\\data\\service-launch.vbs')
    expect(args).toContain('/Create')
    expect(args[args.indexOf('/SC') + 1]).toBe('ONLOGON')
    expect(args[args.indexOf('/TR') + 1]).toBe(
      'wscript.exe //B //NoLogo "C:\\data\\service-launch.vbs"'
    )
    expect(args).toContain('/F')
    expect(args[args.indexOf('/TN') + 1]).toBe(WINDOWS_TASK_NAME)
  })

  it('drives the same task for run, enable, disable and delete', () => {
    expect(runTaskArgs()).toEqual(['/Run', '/TN', WINDOWS_TASK_NAME])
    expect(enableTaskArgs()).toEqual(['/Change', '/TN', WINDOWS_TASK_NAME, '/ENABLE'])
    expect(disableTaskArgs()).toEqual(['/Change', '/TN', WINDOWS_TASK_NAME, '/DISABLE'])
  })

  it('quotes the launcher path in the task action so a space survives', () => {
    expect(windowsTaskAction('C:\\Program Data\\service-launch.vbs')).toBe(
      'wscript.exe //B //NoLogo "C:\\Program Data\\service-launch.vbs"'
    )
  })
})
