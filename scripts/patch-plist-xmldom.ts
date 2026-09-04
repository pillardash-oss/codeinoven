#!/usr/bin/env bun
/**
 * Patch plist@3.1.0's parse.js to pass an explicit mimeType to
 * @xmldom/xmldom's DOMParser.parseFromString().
 *
 * plist depends on "@xmldom/xmldom": "^0.8.8", but this repo overrides
 * @xmldom/xmldom to 0.9.x repo-wide (for our own document-attachment.ts
 * usage and to close bun audit advisories). xmldom 0.9 made the mimeType
 * argument mandatory and throws "the provided mimeType \"undefined\" is
 * not valid" when it's omitted, which plist's parse() never supplies.
 * electron-builder calls plist.parse() while packaging macOS/Windows
 * builds, so this breaks `electron-builder --mac`/`--win` without it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const file = resolve(import.meta.dirname ?? '.', '../node_modules/plist/lib/parse.js')

const original = readFileSync(file, 'utf8')
const target = 'new DOMParser().parseFromString(xml)'
const replacement = "new DOMParser().parseFromString(xml, 'text/xml')"

if (original.includes(replacement)) {
  process.stdout.write('[patch-plist-xmldom] already patched\n')
} else if (original.includes(target)) {
  writeFileSync(file, original.replace(target, replacement), 'utf8')
  process.stdout.write('[patch-plist-xmldom] patched 1 file\n')
} else {
  process.stdout.write('[patch-plist-xmldom] target string not found, skipping\n')
}
