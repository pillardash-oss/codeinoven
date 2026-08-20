#!/usr/bin/env bun
/**
 * Patch @shinyoshiaki/binary-data@0.6.1 which ships with Jest-haste bare
 * specifiers (`require('lib/...')`, `require('internal/...')`, `require('types/...')`)
 * that only resolve under Jest's `providesModuleNodeModules`. Outside Jest
 * (node, Electron, asar) they fail with `Cannot find module 'lib/binary-stream'`.
 *
 * The patch rewrites every bare haste require to a relative require so the
 * package works in normal Node/Electron resolution, including inside an
 * Electron asar archive.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const packageRoot = resolve(import.meta.dirname ?? '.', '../node_modules/@shinyoshiaki/binary-data')
const srcNodeModules = join(packageRoot, 'src/node_modules')

const targets: Record<string, string> = {
  lib: join(srcNodeModules, 'lib'),
  types: join(srcNodeModules, 'types'),
  internal: join(srcNodeModules, 'internal'),
  streams: join(srcNodeModules, 'streams'),
}

function collectJsFiles(root: string, out: string[] = []): string[] {
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(root, entry)
    const st = statSync(full)
    if (st.isDirectory()) collectJsFiles(full, out)
    else if (full.endsWith('.js')) out.push(full)
  }
  return out
}

function patchFile(file: string): boolean {
  const original = readFileSync(file, 'utf8')
  let patched = original
  const dir = file.slice(0, file.lastIndexOf('/')) || '.'

  // Replace require('lib/...') / require("lib/...") etc
  for (const [prefix, targetDir] of Object.entries(targets)) {
    // relative from this file's dir to the target dir
    let rel = relative(dir, targetDir)
    if (!rel) rel = '.'
    // Ensure relative require prefix uses ./ or ../
    if (!rel.startsWith('.')) rel = `./${rel}`

    const singleQ = new RegExp(`require\\('${prefix}\\/`, 'g')
    const doubleQ = new RegExp(`require\\("${prefix}\\/`, 'g')
    // The rest of the path after prefix/ is kept as-is, but the prefix becomes rel/
    patched = patched.replace(singleQ, `require('${rel}/`)
    patched = patched.replace(doubleQ, `require("${rel}/`)
  }

  if (patched !== original) {
    writeFileSync(file, patched, 'utf8')
    return true
  }
  return false
}

const files = collectJsFiles(packageRoot)
let changed = 0
for (const file of files) {
  if (patchFile(file)) changed += 1
}

if (changed > 0) {
  process.stdout.write(`[patch-binary-data] patched ${changed} files\n`)
} else {
  // Verify the critical entry still contains a bare specifier => patch didn't apply
  try {
    const entry = readFileSync(join(packageRoot, 'src/index.js'), 'utf8')
    if (entry.includes("require('lib/") || entry.includes('require("lib/')) {
      process.stdout.write('[patch-binary-data] no files patched but bare specifiers remain\n')
    } else {
      process.stdout.write('[patch-binary-data] already patched\n')
    }
  } catch {
    process.stdout.write('[patch-binary-data] already patched\n')
  }
}
