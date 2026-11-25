import { describe, expect, it } from 'vitest'
import { piCoreToolsHeaderSource } from '../../../src/main/drivers/pi/tools/core-tools-header'

/**
 * The generated extension's recursive-delete rules.
 *
 * They are lifted out of the emitted source and run here, so a change to the
 * text is a change to what these cases exercise. The point these lock in: a
 * flag belongs to the command it is written on. `git status --porcelain` after a
 * plain `rm -f` is not a recursive delete because `--porcelain` contains an `r`.
 */
interface DenyRule {
  pattern: RegExp
  label: string
}

function generatedRules(): DenyRule[] {
  const source = piCoreToolsHeaderSource()
  const start = source.indexOf('// <cio-recursive-delete-rules>')
  const end = source.indexOf('// </cio-recursive-delete-rules>')
  if (start < 0 || end < start)
    throw new Error('The generated source lost its recursive-delete rule block.')
  const block = source
    .slice(start, end)
    .replace('const RECURSIVE_DELETE_RULES: DenyRule[] =', 'const rules =')
  const harness = new Function(`${block}\nreturn rules`)
  return harness() as DenyRule[]
}

function deniesCompletely(rules: DenyRule[], command: string): string | undefined {
  return rules.find((rule) => rule.pattern.test(command))?.label
}

describe('the generated recursive-delete rules', () => {
  it('does not read a later command’s flag as this command’s', () => {
    const rules = generatedRules()

    expect(
      deniesCompletely(
        rules,
        'rm -f .cio/tmp/scan/* 2>/dev/null; for d in ats co; do rm -f .cio/tmp/scan/$d/* 2>/dev/null; done; git status --porcelain | head -5'
      )
    ).toBeUndefined()
    expect(
      deniesCompletely(rules, 'rm -f .cio/tmp/scan/*; git log --pretty=format:%s | head -3')
    ).toBeUndefined()
    expect(deniesCompletely(rules, 'rmdir .cio/tmp/scan; ls -la')).toBeUndefined()
  })

  it('still catches a delete that really is recursive or bulk', () => {
    const rules = generatedRules()

    expect(deniesCompletely(rules, 'rm -rf .cio/tmp/scan')).toContain('recursive')
    expect(deniesCompletely(rules, 'rm -f a; git clean -fdx')).toBe('git clean')
    expect(deniesCompletely(rules, 'find . -name "*.tmp" -delete')).toBe('find -delete')
    expect(deniesCompletely(rules, 'rmdir /s build')).toContain('recursive')
  })
})
