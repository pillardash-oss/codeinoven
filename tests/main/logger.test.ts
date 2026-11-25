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
    Logger.initialize(directory, {
      appVersion: '0.5.70-nightly.15',
      platform: 'darwin',
      platformVersion: '15.5.0',
      architecture: 'arm64',
      electronVersion: '43.2.0'
    })

    Logger.info('request', 'apiKey=super-secret', 'Authorization: Bearer abc.def')
    Logger.error('boom')
    await Logger.flush()

    const dayDirectory = join(directory, logDayName())
    const [bannerLine, line] = (await readFile(join(dayDirectory, MAIN_LOG_FILE), 'utf-8'))
      .trim()
      .split('\n')
    const banner = JSON.parse(bannerLine) as {
      level: string
      appVersion: string
      os: string
      unix: number
      message: string
    }
    expect(banner.level).toBe('info')
    expect(banner.appVersion).toBe('0.5.70-nightly.15')
    expect(banner.os).toBe('darwin 15.5.0 (arm64)')
    expect(banner.unix).toBeGreaterThan(0)
    expect(banner.message).toContain('0.5.70-nightly.15')
    expect(banner.message).toContain('15.5.0')

    const record = JSON.parse(line) as {
      level: string
      message: string
      unix: number
      appVersion: string
      os: string
      timestamp: string
    }
    expect(record.level).toBe('info')
    expect(record.appVersion).toBe('0.5.70-nightly.15')
    expect(record.os).toBe('darwin 15.5.0 (arm64)')
    expect(record.unix).toBe(Date.parse(record.timestamp))
    expect(record.message).toContain('apiKey=[REDACTED]')
    expect(record.message).toContain('Authorization: [REDACTED]')
    expect(record.message).not.toContain('super-secret')
    expect(record.message).not.toContain('abc.def')

    // The operator-readable mirrors live in the same day folder.
    const debug = await readFile(join(dayDirectory, DEBUG_LOG_FILE), 'utf-8')
    expect(debug).toContain('[v0.5.70-nightly.15] [info] session start')
    expect(debug).toContain('[error] boom')
    const errors = await readFile(join(dayDirectory, ERROR_LOG_FILE), 'utf-8')
    expect(errors).toContain('[error] boom')
    expect(errors).not.toContain('[info]')
  })
})
