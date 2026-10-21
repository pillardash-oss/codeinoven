import { describe, expect, it } from 'vitest'
import {
  IANA_TO_WINDOWS_TIME_ZONE,
  windowsTimeZoneFor
} from '../../../src/main/ovens/windows-timezones'
import { timezoneSetCommands } from '../../../src/main/ovens/oven-timezone'

describe('windows time zone names', () => {
  it('translates the zones a person is likely to live in', () => {
    expect(windowsTimeZoneFor('Africa/Lagos')).toBe('W. Central Africa Standard Time')
    expect(windowsTimeZoneFor('Europe/London')).toBe('GMT Standard Time')
    expect(windowsTimeZoneFor('America/New_York')).toBe('Eastern Standard Time')
    expect(windowsTimeZoneFor('Asia/Tokyo')).toBe('Tokyo Standard Time')
    expect(windowsTimeZoneFor('UTC')).toBe('UTC')
  })

  it('refuses a zone Windows has no name for instead of guessing one', () => {
    expect(windowsTimeZoneFor('Mars/Olympus_Mons')).toBeNull()
    expect(windowsTimeZoneFor('')).toBeNull()
  })

  it('accepts a zone whose case differs from the catalogue', () => {
    expect(windowsTimeZoneFor('africa/lagos')).toBe('W. Central Africa Standard Time')
  })

  it('maps every zone to a non-empty Windows name and nothing to itself', () => {
    for (const [iana, windows] of Object.entries(IANA_TO_WINDOWS_TIME_ZONE)) {
      expect(iana.length).toBeGreaterThan(0)
      expect(windows.length).toBeGreaterThan(0)
      expect(windows).not.toBe(iana)
    }
  })
})

describe('windows timezone command', () => {
  it('sends the Windows name so a PowerShell 5.1 Oven can apply it', () => {
    const commands = timezoneSetCommands({
      platform: 'win32',
      method: 'powershell',
      zone: 'Africa/Lagos',
      privilege: 'root'
    })
    expect(Array.isArray(commands)).toBe(true)
    const [command] = commands as { line: string }[]
    // The whole script travels base64 encoded; decode it the way the Oven does.
    const encoded = /-EncodedCommand (\S+)$/u.exec(command.line)?.[1] ?? ''
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(script).toContain("$windows = 'W. Central Africa Standard Time'")
    expect(script).toContain('Set-TimeZone -Id $windows')
    // The old path needed PowerShell 6 on the Oven, which most Windows Ovens lack.
    expect(script).not.toContain('TryConvertIanaIdToWindowsId')
  })

  it('still asks the Oven to translate a zone the catalogue does not know', () => {
    const commands = timezoneSetCommands({
      platform: 'win32',
      method: 'powershell',
      zone: 'Some/New_Zone',
      privilege: 'root'
    })
    const [command] = commands as { line: string }[]
    const encoded = /-EncodedCommand (\S+)$/u.exec(command.line)?.[1] ?? ''
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(script).toContain('TryConvertIanaIdToWindowsId')
  })

  it('refuses a Windows clock change without an administrator session', () => {
    const commands = timezoneSetCommands({
      platform: 'win32',
      method: 'powershell',
      zone: 'Africa/Lagos',
      privilege: 'none'
    })
    expect(Array.isArray(commands)).toBe(false)
    expect((commands as { reason: string }).reason).toContain('administrator')
  })
})
