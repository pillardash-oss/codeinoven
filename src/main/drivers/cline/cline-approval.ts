import { permissionPatterns } from '../../../lib/agent-interactions'
import type { PermissionRequest } from '../../permissions/permission-policy'
import { record, stringValue } from './cline-values'

/** Desktop-approval bridge state for one Cline turn. */
export interface ClineApprovalBridge {
  directory: string
  timer: ReturnType<typeof setInterval>
  handled: Set<string>
}

const CLINE_WEB_ONLY_TOOL_NAMES = new Set(['question', 'webfetch', 'websearch', 'gemini_quota'])

export function isClineWebOnlyTurn(allowedTools: readonly string[] | undefined): boolean {
  return (
    allowedTools !== undefined &&
    allowedTools.some((tool) => tool === 'webfetch' || tool === 'websearch') &&
    allowedTools.every((tool) => CLINE_WEB_ONLY_TOOL_NAMES.has(tool))
  )
}

export function clineWebOnlyHook(allowedAttachmentPaths: readonly string[]): string {
  return `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const allowedPaths = new Set(${JSON.stringify(allowedAttachmentPaths)}.map((path) => resolve(path)))
const payload = JSON.parse(readFileSync(0, 'utf8'))
const request = payload.preToolUse ?? {}
const tool = request.tool ?? request.toolName ?? ''
const parameters = request.parameters ?? {}

function values(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(values)
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, nested]) =>
    ['path', 'filePath', 'file_path', 'paths', 'files', 'file_paths'].includes(key)
      ? values(nested)
      : []
  )
}

const webTools = new Set(['fetch_web_content', 'web_search', 'websearch', 'webfetch'])
const neutralTools = new Set(['ask_question', 'submit_and_exit'])
let allowed = webTools.has(tool) || neutralTools.has(tool)
if (tool === 'read_files') {
  const paths = values(parameters)
  allowed = paths.length > 0 && paths.every((path) => {
    if (!isAbsolute(path)) return false
    return allowedPaths.has(resolve(path))
  })
}

process.stdout.write(JSON.stringify(
  allowed
    ? { cancel: false }
    : {
        cancel: true,
        errorMessage: 'This inbox chat can use the web and read files explicitly attached by the user, but it cannot access other local files or run local commands.'
      }
))
`
}

/** Map Cline's tool names onto the app's provider-neutral permission names. */
function clineToolPermission(toolName: string): string {
  const normalized = toolName.toLowerCase()
  if (/command|run_commands|terminal|bash|shell/iu.test(normalized)) return 'bash'
  if (/write|edit|create|apply|delete|rename|move|filesystem|file-change/iu.test(normalized)) {
    return 'write'
  }
  if (/read|list|search|grep|context/iu.test(normalized)) return 'read'
  if (/fetch|web|http|request/iu.test(normalized)) return 'network'
  if (/mcp|tool/iu.test(normalized)) return 'mcp'
  return normalized.replace(/[^a-z0-9_-]+/gu, '-') || 'tool'
}

/** Extract the command strings Cline passes for shell/command tools. */
function clineApprovalCommands(input: Record<string, unknown>): string[] {
  const commands: string[] = []
  const append = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) commands.push(value.trim())
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry.trim()) commands.push(entry.trim())
      }
    }
  }
  append(input['commands'])
  append(input['command'])
  return commands
}

export function clineApprovalRequest(payload: Record<string, unknown>): PermissionRequest {
  const toolInput = record(payload['input']) ?? {}
  const paths = permissionPatterns(toolInput)
  const commands = clineApprovalCommands(toolInput)
  return {
    permission: clineToolPermission(stringValue(payload['toolName']) ?? 'tool'),
    ...(paths.length > 0 ? { paths } : {}),
    ...(commands.length > 0 ? { commands } : {})
  }
}
