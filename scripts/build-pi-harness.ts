#!/usr/bin/env bun
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBundledPiHarness, defaultBundledPiHarnessDirectory } from './pi-harness-bundle'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const directory = defaultBundledPiHarnessDirectory()
const { version, prunedFiles, prunedBytes, shippedBytes } = await buildBundledPiHarness(directory)
const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`

// eslint-disable-next-line no-console
console.log(
  `bundled pi ${version} -> ${relative(projectRoot, directory)} ` +
    `(${megabytes(shippedBytes)} shipped, ${prunedFiles} build-only files pruned, ${megabytes(prunedBytes)} dropped)`
)
