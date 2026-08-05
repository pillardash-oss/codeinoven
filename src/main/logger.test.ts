import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Logger } from './logger'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Logger', () => {
  it('writes structured durable logs and redacts common credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codeinoven-logger-'))
    temporaryPaths.push(directory)
    const logPath = join(directory, 'main.jsonl')
    Logger.initialize(logPath)

    Logger.info('request', 'apiKey=super-secret', 'Authorization: Bearer abc.def')
    await Logger.flush()

    const [line] = (await readFile(logPath, 'utf-8')).trim().split('\n')
    const record = JSON.parse(line) as { level: string; message: string }
    expect(record.level).toBe('info')
    expect(record.message).toContain('apiKey=[REDACTED]')
    expect(record.message).toContain('Authorization: [REDACTED]')
    expect(record.message).not.toContain('super-secret')
    expect(record.message).not.toContain('abc.def')
  })
})
