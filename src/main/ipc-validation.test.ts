import { describe, expect, it } from 'vitest'
import {
  validateBoolean,
  validateBoundedInteger,
  validateBoundedString,
  validateChecklistItemStatus,
  validateCreateProjectInput,
  validateCreateThreadInput,
  validateEntityId,
  validateHistoryRole,
  validateThreadSettings,
  validateThreadStatus
} from './ipc-validation'

const validSettings = {
  harnessId: 'opencode',
  providerId: 'anthropic',
  modelId: 'anthropic/claude-sonnet-4',
  thinkingLevel: 'high',
  permissionLevel: 'auto_review',
  engineeringMode: true,
  assignmentMode: false,
  loopMode: false
}

describe('IPC primitive validation', () => {
  it('accepts safe entity IDs and rejects traversal or separators', () => {
    expect(validateEntityId(' codeinoven-inbox ')).toBe('codeinoven-inbox')

    for (const value of ['.', '..', '../secret', 'project/child', 'project\\child', '']) {
      expect(() => validateEntityId(value)).toThrow(TypeError)
    }
  })

  it('validates booleans without coercion', () => {
    expect(validateBoolean(false)).toBe(false)
    expect(() => validateBoolean(0)).toThrow(TypeError)
    expect(() => validateBoolean('true')).toThrow(TypeError)
  })

  it('validates bounded safe integers', () => {
    expect(validateBoundedInteger(10, 'Limit', 1, 10)).toBe(10)

    for (const value of [0, 11, 1.5, Number.MAX_VALUE, '2']) {
      expect(() => validateBoundedInteger(value, 'Limit', 1, 10)).toThrow(TypeError)
    }
  })

  it('trims bounded strings and rejects null bytes', () => {
    expect(validateBoundedString('  CodeInOven  ', 'Name', 1, 20)).toBe('CodeInOven')
    expect(() => validateBoundedString('   ', 'Name', 1, 20)).toThrow(TypeError)
    expect(() => validateBoundedString('bad\0value', 'Name', 1, 20)).toThrow(TypeError)
  })
})

describe('IPC enum validation', () => {
  it('validates every thread status', () => {
    const statuses = [
      'created',
      'planning',
      'awaiting_approval',
      'executing',
      'interrupted',
      'completed',
      'failed'
    ]

    for (const status of statuses) {
      expect(validateThreadStatus(status)).toBe(status)
    }
    expect(() => validateThreadStatus('running')).toThrow(TypeError)
  })

  it('validates history roles and checklist statuses', () => {
    expect(validateHistoryRole('assistant')).toBe('assistant')
    expect(validateChecklistItemStatus('in_progress')).toBe('in_progress')
    expect(() => validateHistoryRole('developer')).toThrow(TypeError)
    expect(() => validateChecklistItemStatus('done')).toThrow(TypeError)
  })
})

describe('IPC structured input validation', () => {
  it('sanitizes complete thread settings', () => {
    expect(
      validateThreadSettings({
        ...validSettings,
        harnessId: ' opencode ',
        modelId: ' anthropic/claude-sonnet-4 '
      })
    ).toEqual(validSettings)
  })

  it('rejects invalid, incomplete, and extended thread settings', () => {
    expect(() => validateThreadSettings({ ...validSettings, engineeringMode: 'yes' })).toThrow(
      TypeError
    )
    expect(() => validateThreadSettings({ ...validSettings, permissionLevel: 'all' })).toThrow(
      TypeError
    )
    expect(() => validateThreadSettings({ ...validSettings, extra: true })).toThrow(
      'Unsupported thread settings field'
    )
    expect(() =>
      validateThreadSettings({
        harnessId: 'opencode',
        providerId: 'anthropic'
      })
    ).toThrow(TypeError)
  })

  it('sanitizes create-project input and preserves valid options', () => {
    expect(
      validateCreateProjectInput({
        name: ' CodeInOven ',
        path: ' /projects/codeinoven ',
        source: 'ssh',
        host: ' dev.example.test ',
        providerId: 'opencode',
        workflowId: 'engineering',
        threadLimit: 80,
        hidden: false,
        changeTrackingMode: 'manual'
      })
    ).toEqual({
      name: 'CodeInOven',
      path: '/projects/codeinoven',
      source: 'ssh',
      host: 'dev.example.test',
      providerId: 'opencode',
      workflowId: 'engineering',
      threadLimit: 80,
      hidden: false,
      changeTrackingMode: 'manual'
    })
  })

  it('rejects unknown or invalid create-project fields', () => {
    expect(() =>
      validateCreateProjectInput({
        name: 'CodeInOven',
        path: '/projects/codeinoven',
        owner: 'user'
      })
    ).toThrow('Unsupported create project field')
    expect(() =>
      validateCreateProjectInput({
        name: 'CodeInOven',
        path: '/projects/codeinoven',
        threadLimit: 1001
      })
    ).toThrow(TypeError)
    expect(() =>
      validateCreateProjectInput({
        name: 'CodeInOven',
        path: '/projects/codeinoven',
        source: 'remote'
      })
    ).toThrow(TypeError)
  })

  it('sanitizes create-thread input including nested settings', () => {
    expect(
      validateCreateThreadInput({
        projectId: ' project-1 ',
        providerId: 'opencode',
        title: ' Implement IPC validation ',
        workingDirectory: ' /projects/codeinoven ',
        settings: validSettings
      })
    ).toEqual({
      projectId: 'project-1',
      providerId: 'opencode',
      title: 'Implement IPC validation',
      workingDirectory: '/projects/codeinoven',
      settings: validSettings
    })
  })

  it('rejects unknown or unsafe create-thread fields', () => {
    expect(() =>
      validateCreateThreadInput({
        projectId: '../project',
        providerId: 'opencode',
        title: 'Unsafe'
      })
    ).toThrow(TypeError)
    expect(() =>
      validateCreateThreadInput({
        projectId: 'project-1',
        providerId: 'opencode',
        title: 'Unknown',
        status: 'created'
      })
    ).toThrow('Unsupported create thread field')
  })
})
