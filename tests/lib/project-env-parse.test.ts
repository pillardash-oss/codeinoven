import { describe, expect, it } from 'vitest'
import {
  formatProjectEnvLine,
  isEnvFileNameTaken,
  parseProjectEnvFile,
  projectEnvKeysText,
  PROJECT_ENV_DISABLED_PREFIX,
  sameEnvFileName,
  suggestEnvFileName
} from '../../src/lib/project-env'

/** Only the assignment lines, which is what an editor turns into key rows. */
function assignments(text: string): { name: string; value: string; disabled: boolean }[] {
  return parseProjectEnvFile(text).flatMap((line) =>
    line.kind === 'assignment'
      ? [{ name: line.name, value: line.value, disabled: line.disabled }]
      : []
  )
}

describe('parseProjectEnvFile', () => {
  it('reads only the app marker as a turned-off key', () => {
    const text = [
      '# plain note',
      '#cio-cmt FEATURE_FLAG=on',
      '#cio-cmt-notes FEATURE_FLAG=on',
      '#cio-cmtx FEATURE_FLAG=on',
      '#cio-cmt',
      'PORT=3000'
    ].join('\n')

    expect(assignments(text)).toEqual([
      { name: 'FEATURE_FLAG', value: 'on', disabled: true },
      { name: 'PORT', value: '3000', disabled: false }
    ])
    expect(parseProjectEnvFile(text).filter((line) => line.kind === 'comment')).toHaveLength(4)
  })

  it('keeps every comment and blank line exactly as written', () => {
    const text = '#   spaced\n\n  # indented\nPORT=3000\n'
    expect(parseProjectEnvFile(text).map((line) => line.text)).toEqual([
      '#   spaced',
      '',
      '  # indented',
      'PORT=3000',
      ''
    ])
  })
})

describe('formatProjectEnvLine', () => {
  it('comments a turned-off key with the marker and round-trips through the parser', () => {
    const on = formatProjectEnvLine('PORT', '3000')
    const off = formatProjectEnvLine('MAIL_KEY', 'a b#c', true)

    expect(on).toBe('PORT=3000')
    expect(off).toBe(`${PROJECT_ENV_DISABLED_PREFIX} MAIL_KEY="a b#c"`)
    expect(assignments(`${on}\n${off}\n`)).toEqual([
      { name: 'PORT', value: '3000', disabled: false },
      { name: 'MAIL_KEY', value: 'a b#c', disabled: true }
    ])
  })
})

describe('env file names', () => {
  it('compares names the way the filesystem does', () => {
    expect(sameEnvFileName('.env', '.ENV')).toBe(true)
    expect(sameEnvFileName('.env', '.env.local')).toBe(false)
    expect(isEnvFileNameTaken(['.env.local'], ' .ENV.LOCAL ')).toBe(true)
    expect(isEnvFileNameTaken(['.env.local'], '.env')).toBe(false)
  })

  it('suggests the first name a directory does not already use', () => {
    expect(suggestEnvFileName([])).toBe('.env')
    expect(suggestEnvFileName(['.env'])).toBe('.env.local')
    expect(suggestEnvFileName(['.env', '.ENV.local', '.env.development'])).toBe('.env.production')
    expect(
      suggestEnvFileName(['.env', '.env.local', '.env.development', '.env.production', '.env.test'])
    ).toBe('.env.2')
    expect(suggestEnvFileName(['.env', '.env.2'])).toBe('.env.local')
  })
})

describe('projectEnvKeysText', () => {
  it('keeps the keys and drops the lines the key list cannot hold', () => {
    const text = ['# deployment note', 'PORT=3000', '', '#cio-cmt FEATURE_FLAG=off'].join('\n')
    expect(projectEnvKeysText(text)).toBe(
      ['PORT=3000', `${PROJECT_ENV_DISABLED_PREFIX} FEATURE_FLAG=off`].join('\n')
    )
  })

  it('reports a file with comments as unchanged when its keys are', () => {
    // The panel compares the key surface against this form, so a comment a row can
    // never reproduce must not read as an edit after a save in the editor.
    const saved = ['# note', 'PORT=3000', '', 'DEBUG=1'].join('\n')
    expect(projectEnvKeysText(saved)).toBe(projectEnvKeysText(['PORT=3000', 'DEBUG=1'].join('\n')))
  })

  it('still reports a changed key', () => {
    const saved = ['# note', 'PORT=3000'].join('\n')
    expect(projectEnvKeysText(saved)).not.toBe(
      projectEnvKeysText(['# note', 'PORT=4000'].join('\n'))
    )
  })
})
