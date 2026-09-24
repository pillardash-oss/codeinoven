import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Logger } from '../../src/main/system/logger'
import {
  DEBUG_LOG_FILE,
  ERROR_LOG_FILE,
  MAIN_LOG_FILE,
  logDayName
} from '../../src/main/system/log-paths'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('Logger', () => {
  it('writes structured durable logs into the day folder and redacts common credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codeinoven-logger-'))
    temporaryPaths.push(directory)
    Logger.initialize(directory)

    Logger.info('request', 'apiKey=super-secret', 'Authorization: Bearer abc.def')
    Logger.error('boom')
    await Logger.flush()

    const dayDirectory = join(directory, logDayName())
    const [line] = (await readFile(join(dayDirectory, MAIN_LOG_FILE), 'utf-8')).trim().split('\n')
    const record = JSON.parse(line) as { level: string; message: string }
    expect(record.level).toBe('info')
    expect(record.message).toContain('apiKey=[REDACTED]')
    expect(record.message).toContain('Authorization: [REDACTED]')
    expect(record.message).not.toContain('super-secret')
    expect(record.message).not.toContain('abc.def')

    // The operator-readable mirrors live in the same day folder.
    const debug = await readFile(join(dayDirectory, DEBUG_LOG_FILE), 'utf-8')
    expect(debug).toContain('[error] boom')
    const errors = await readFile(join(dayDirectory, ERROR_LOG_FILE), 'utf-8')
    expect(errors).toContain('[error] boom')
    expect(errors).not.toContain('[info]')
  })
})
