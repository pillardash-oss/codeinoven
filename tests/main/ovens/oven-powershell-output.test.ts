import { describe, expect, it } from 'vitest'
import { plainPowerShellStderr } from '../../../src/main/ovens/oven-powershell-output'

/** A transcript shaped like Windows PowerShell 5.1 over SSH. */
const progressOnly =
  '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
  '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T>' +
  '<T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules' +
  ' for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR>' +
  '<SD> </SD></PR></MS></Obj></Objs>'

const withError =
  '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
  '<Obj S="progress" RefId="0"><TN RefId="0"><MS><PR N="Record"><AV>Preparing modules</AV>' +
  '</PR></MS></Obj><S S="Error">Set-TimeZone : Access is denied_x000D__x000A_</S>' +
  '<S S="Error">At line:5 char:1_x000D__x000A_</S></Objs>'

describe('powershell stderr over SSH', () => {
  it('drops transport progress that names no cause', () => {
    expect(plainPowerShellStderr(progressOnly)).toBe('')
  })

  it('keeps the error records and decodes their escaped characters', () => {
    const text = plainPowerShellStderr(withError)
    expect(text).toContain('Set-TimeZone : Access is denied')
    expect(text).toContain('At line:5 char:1')
    // The escape sequences are clixml's own, not something to show a person.
    expect(text).not.toContain('_x000D_')
    expect(text).not.toContain('CLIXML')
    expect(text).not.toContain('progress')
  })

  it('passes ordinary stderr straight through', () => {
    expect(plainPowerShellStderr('bash: node: command not found')).toBe(
      'bash: node: command not found'
    )
  })
})
