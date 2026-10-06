#!/usr/bin/env node
import { main } from '../dist/cli.mjs'

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`\ncio-oven: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
