#!/usr/bin/env bun
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBundledPiHarness, defaultBundledPiHarnessDirectory } from './pi-harness-bundle'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const directory = defaultBundledPiHarnessDirectory()
const { version } = await buildBundledPiHarness(directory)

// eslint-disable-next-line no-console
console.log(`bundled pi ${version} -> ${relative(projectRoot, directory)}`)
