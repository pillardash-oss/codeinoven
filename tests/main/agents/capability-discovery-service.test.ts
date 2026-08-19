import { describe, expect, it, vi } from 'vitest'
import * as os from 'node:os'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { CapabilityDiscoveryService } from '../../../src/main/agents/capability-discovery-service'

const { mockHome } = vi.hoisted(() => ({ mockHome: { value: '' } }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => mockHome.value }
})

const sharedSkill = `---
name: Global skill
description: Loaded for every harness.
---

# Global skill

Shared instructions.
`

const harnessSkill = `---
name: OpenCode skill
description: Only loaded by OpenCode.
---

# OpenCode skill

Harness instructions.
`

function writeSkill(root: string, relative: string, content: string): void {
  const path = join(root, relative)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'SKILL.md'), content, 'utf8')
}

describe('CapabilityDiscoveryService.discoverAll', () => {
  it('aggregates shared-global, harness, and project skills with attribution', async () => {
    const home = mkdtempSync(join(os.tmpdir(), 'cio-cap-home-'))
    const project = mkdtempSync(join(os.tmpdir(), 'cio-cap-project-'))
    mockHome.value = home

    try {
      writeSkill(home, '.agents/skills/global-skill', sharedSkill)
      writeSkill(project, '.opencode/skills/opencode-skill', harnessSkill)
      writeSkill(project, '.agents/skills/project-shared', `---\nname: Project shared\n---\n`)
      writeFileSync(
        join(project, '.opencode', 'opencode.json'),
        JSON.stringify(
          {
            mcp: {
              'project-server': {
                command: 'bunx',
                args: ['server@latest'],
                enabled: true
              }
            }
          },
          null,
          2
        ),
        'utf8'
      )

      const service = new CapabilityDiscoveryService()
      const catalog = await service.discoverAll([{ id: 'project-1', path: project }])

      const globalSkill = catalog.skill.find((entry) => entry.name === 'Global skill')
      expect(globalSkill).toBeDefined()
      expect(globalSkill?.origin).toBe('global')
      expect(globalSkill?.harnessId).toBeUndefined()
      expect(globalSkill?.projectId).toBeUndefined()

      const harnessSkillEntry = catalog.skill.find((entry) => entry.name === 'OpenCode skill')
      expect(harnessSkillEntry).toBeDefined()
      expect(harnessSkillEntry?.origin).toBe('harness')
      expect(harnessSkillEntry?.harnessId).toBe('opencode')
      expect(harnessSkillEntry?.projectId).toBe('project-1')

      const projectShared = catalog.skill.find((entry) => entry.name === 'Project shared')
      expect(projectShared).toBeDefined()
      expect(projectShared?.origin).toBe('global')
      expect(projectShared?.projectId).toBe('project-1')

      const projectMcp = catalog.mcp.find((entry) => entry.name === 'project-server')
      expect(projectMcp).toBeDefined()
      expect(projectMcp?.origin).toBe('harness')
      expect(projectMcp?.harnessId).toBe('opencode')
      expect(projectMcp?.projectId).toBe('project-1')
      expect(projectMcp?.detail).toContain('stdio')
    } finally {
      mockHome.value = ''
      rmSync(home, { recursive: true, force: true })
      rmSync(project, { recursive: true, force: true })
    }
  })
})
