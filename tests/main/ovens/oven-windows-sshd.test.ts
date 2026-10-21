import { describe, expect, it } from 'vitest'
import {
  WINDOWS_SSHD_SERVICE,
  WINDOWS_SSHD_STARTUP_COMMAND,
  sshdStartsAutomatically,
  windowsSshdStartupScript,
  windowsSshdStepDetail
} from '../../../src/main/ovens/remote/oven-windows-sshd'

describe('windows sshd startup repair', () => {
  it('only touches the start type when the service is not already automatic', () => {
    const script = windowsSshdStartupScript()
    expect(script).toContain(`Get-Service -Name ${WINDOWS_SSHD_SERVICE}`)
    expect(script).toContain(`if ($service.StartType -ne 'Automatic') { Set-Service`)
    // The answer is read back, so the app reports a fact instead of assuming one.
    expect(script).toContain('(Get-Service -Name sshd).StartType.ToString()')
    expect(script).not.toContain('\n')
  })

  it('reads the start type the Oven reports back', () => {
    expect(sshdStartsAutomatically('Automatic\r\n')).toBe(true)
    expect(sshdStartsAutomatically('Manual')).toBe(false)
    expect(sshdStartsAutomatically('')).toBe(false)
    // A service that is merely "AutomaticDelayedStart"-like text is not Automatic.
    expect(sshdStartsAutomatically('Disabled')).toBe(false)
  })

  it('names the one command a person runs when the Oven refuses', () => {
    expect(WINDOWS_SSHD_STARTUP_COMMAND).toBe(
      'Set-Service -Name sshd -StartupType Automatic; Start-Service sshd'
    )
    const detail = windowsSshdStepDetail()
    expect(detail).toContain('restart')
    expect(detail).not.toContain('\u2014')
  })
})
