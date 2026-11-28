import { describe, expect, it } from 'vitest'
import {
  formatProjectEnvLine,
  isEnvFileNameTaken,
  mergeProjectEnvRows,
  parseProjectEnvFile,
  projectEnvFileText,
  projectEnvLayout,
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

describe('mergeProjectEnvRows', () => {
  it('writes the rows in place and keeps the comments around them', () => {
    const body = ['# deployment', 'PORT=3000', '', '# keep this note', 'DEBUG=1'].join('\n')
    const merged = mergeProjectEnvRows(body, [
      { name: 'PORT', value: '4000' },
      { name: 'DEBUG', value: '1' }
    ])
    expect(merged).toBe(['# deployment', 'PORT=4000', '', '# keep this note', 'DEBUG=1'].join('\n'))
  })

  it('drops the line of a key that is gone and appends a new one above a blank tail', () => {
    const body = ['# note', 'PORT=3000', ''].join('\n')
    const merged = mergeProjectEnvRows(body, [{ name: 'DEBUG', value: '1' }])
    expect(merged).toBe(['# note', 'DEBUG=1', ''].join('\n'))
  })

  it('keeps a turned-off key off and an unnamed row out of the file', () => {
    const merged = mergeProjectEnvRows('PORT=3000', [
      { name: 'PORT', value: '3000', disabled: true },
      { name: '  ', value: 'ignored' }
    ])
    expect(merged).toBe(`${PROJECT_ENV_DISABLED_PREFIX} PORT=3000`)
    expect(merged).toBe(formatProjectEnvLine('PORT', '3000', true))
  })
})

describe('projectEnvLayout and projectEnvFileText', () => {
  const entries = [
    { name: 'PORT', secretRef: 'ref-1', updatedAt: 0 },
    { name: 'DEBUG', secretRef: 'ref-2', updatedAt: 0, disabled: true }
  ]
  const values = new Map([
    ['PORT', '3000'],
    ['DEBUG', '1']
  ])

  it('stores the shape of a body, with each key reduced to its name', () => {
    const layout = projectEnvLayout(['# deployment', 'PORT=3000', '', 'DEBUG=1'].join('\n'))
    expect(layout).toEqual([
      { kind: 'text', text: '# deployment' },
      { kind: 'key', name: 'PORT' },
      { kind: 'text', text: '' },
      { kind: 'key', name: 'DEBUG' }
    ])
    // Nothing a layout holds can be a value, so a manifest carrying one stays safe.
    expect(JSON.stringify(layout)).not.toContain('3000')
  })

  it('rebuilds the body a user wrote, with the stored values in it', () => {
    const body = ['# deployment', 'PORT=3000', '', 'DEBUG=1'].join('\n')
    expect(projectEnvFileText({ layout: projectEnvLayout(body), entries }, values)).toBe(
      ['# deployment', 'PORT=3000', '', `${PROJECT_ENV_DISABLED_PREFIX} DEBUG=1`].join('\n')
    )
  })

  it('appends a key the layout has never seen and drops one it no longer holds', () => {
    const layout = projectEnvLayout(['# note', 'PORT=3000', 'GONE=1'].join('\n'))
    expect(projectEnvFileText({ layout, entries }, values)).toBe(
      ['# note', 'PORT=3000', `${PROJECT_ENV_DISABLED_PREFIX} DEBUG=1`].join('\n')
    )
  })

  it('lists the keys of a file that has no layout yet', () => {
    expect(projectEnvFileText({ entries }, values)).toBe(
      ['PORT=3000', `${PROJECT_ENV_DISABLED_PREFIX} DEBUG=1`].join('\n')
    )
  })
})
