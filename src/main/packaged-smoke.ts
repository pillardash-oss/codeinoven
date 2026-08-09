/// <reference types="node" />

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { StartupTelemetrySnapshot } from './startup-telemetry'

export const PACKAGED_SMOKE_OUTPUT_ENV = 'CODEINOVEN_PACKAGED_SMOKE_OUTPUT'

/** Write the packaged-startup proof atomically so CI never accepts a partial result. */
export async function writePackagedSmokeProof(
  outputPath: string,
  startup: StartupTelemetrySnapshot
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true })
  const temporaryPath = `${outputPath}.${process.pid}.tmp`
  const proof = {
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    startup
  }
  await writeFile(temporaryPath, `${JSON.stringify(proof, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  await rename(temporaryPath, outputPath)
}
