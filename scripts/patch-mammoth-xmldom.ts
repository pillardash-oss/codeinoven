#!/usr/bin/env bun
/**
 * Patch mammoth@1.12.2's xmldom adapter for @xmldom/xmldom 0.9.x.
 *
 * mammoth depends on "@xmldom/xmldom": "^0.8.6", but this repo overrides
 * @xmldom/xmldom to 0.9.x repo-wide (same reason as patch-plist-xmldom.ts).
 * xmldom 0.9 made two breaking changes that break mammoth's DOCX parsing:
 *
 * 1. `DOMParser.parseFromString()` requires an explicit mimeType; omitting it
 *    throws "the provided mimeType \"undefined\" is not valid".
 * 2. The `errorHandler` constructor option was removed in favour of `onError`;
 *    passing `errorHandler` makes 0.9 throw a deprecation error.
 *
 * Without this patch every DOCX attachment/document preview fails at runtime
 * (readDocumentPreviewHtml / readDocumentText return null).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const file = resolve(import.meta.dirname ?? '.', '../node_modules/mammoth/lib/xml/xmldom.js')

let original = readFileSync(file, 'utf8')

// 1. mimeType argument (xmldom 0.9 makes it mandatory)
const mimeTarget = 'var document = domParser.parseFromString(string);'
const mimeReplacement = 'var document = domParser.parseFromString(string, "text/xml");'

// 2. onError instead of the removed errorHandler option
const handlerTarget = 'errorHandler: function(level, message) {'
const handlerReplacement = 'onError: function(level, message) {'

let changed = false
if (original.includes(mimeReplacement) && original.includes(handlerReplacement)) {
  process.stdout.write('[patch-mammoth-xmldom] already patched\n')
} else {
  if (original.includes(mimeTarget)) {
    original = original.replace(mimeTarget, mimeReplacement)
    changed = true
  }
  if (original.includes(handlerTarget)) {
    original = original.replace(handlerTarget, handlerReplacement)
    changed = true
  }
  if (changed) {
    writeFileSync(file, original, 'utf8')
    process.stdout.write('[patch-mammoth-xmldom] patched lib/xml/xmldom.js\n')
  } else {
    process.stdout.write('[patch-mammoth-xmldom] target strings not found, skipping\n')
  }
}
