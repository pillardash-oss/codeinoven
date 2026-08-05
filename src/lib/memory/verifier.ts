import type { MemoryEntry } from '../types'
import { generateChecklist } from './formatter'

export interface VerificationResult {
  passed: boolean
  violations: Violation[]
  checkedCount: number
}

export interface Violation {
  entryId: string
  label: string
  priority: string
  expected: string
  description: string
}

/**
 * Verify an agent's output against the memory checklist.
 * This performs pattern-based checking for common violations.
 */
export function verifyOutput(
  output: string,
  entries: MemoryEntry[]
): VerificationResult {
  const checklist = generateChecklist(entries)
  if (checklist.length === 0) {
    return { passed: true, violations: [], checkedCount: 0 }
  }

  const violations: Violation[] = []
  const criticalAndHigh = entries.filter(
    (e) => e.enabled && (e.priority === 'critical' || e.priority === 'high')
  )

  for (const entry of criticalAndHigh) {
    const violation = checkEntry(output, entry)
    if (violation) {
      violations.push(violation)
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    checkedCount: criticalAndHigh.length
  }
}

function checkEntry(output: string, entry: MemoryEntry): Violation | null {
  const lowerOutput = output.toLowerCase()
  const lowerContent = entry.content.toLowerCase()
  const lowerLabel = entry.label.toLowerCase()

  // Check for "always" rules: if the memory says "always do X", the output should do X
  const alwaysMatch = lowerContent.match(/always\s+(?:use|do|make|write|put|include|add)\s+(.+)/i)
  if (alwaysMatch) {
    const required = alwaysMatch[1].trim()
    if (!lowerOutput.includes(required.slice(0, 20))) {
      return {
        entryId: entry.id,
        label: entry.label,
        priority: entry.priority,
        expected: `Should include: ${required}`,
        description: `Memory rule "${entry.label}" requires always doing "${required}", but it was not found in the output.`
      }
    }
  }

  // Check for "never" rules: if the memory says "never do X", the output should not do X
  const neverMatch = lowerContent.match(/never\s+(?:use|do|make|write|put|include|add|remove)\s+(.+)/i)
  if (neverMatch) {
    const forbidden = neverMatch[1].trim()
    if (lowerOutput.includes(forbidden.slice(0, 20))) {
      return {
        entryId: entry.id,
        label: entry.label,
        priority: entry.priority,
        expected: `Should NOT include: ${forbidden}`,
        description: `Memory rule "${entry.label}" forbids "${forbidden}", but it was found in the output.`
      }
    }
  }

  // Check for "do not" rules
  const doNotMatch = lowerContent.match(/do\s+not\s+(?:ever\s+)?(?:use|do|make|write|put|include|add|remove)\s+(.+)/i)
  if (doNotMatch) {
    const forbidden = doNotMatch[1].trim()
    if (lowerOutput.includes(forbidden.slice(0, 20))) {
      return {
        entryId: entry.id,
        label: entry.label,
        priority: entry.priority,
        expected: `Should NOT include: ${forbidden}`,
        description: `Memory rule "${entry.label}" says not to use "${forbidden}", but it was found in the output.`
      }
    }
  }

  // Check for "use X" rules (project conventions)
  const useMatch = lowerContent.match(/(?:use|follow|adhere\s+to)\s+(?:the\s+)?(.+)/i)
  if (useMatch && !alwaysMatch) {
    const required = useMatch[1].trim()
    // Only flag if the output mentions the topic but not the required tool/approach
    if (lowerOutput.includes(lowerLabel) && !lowerOutput.includes(required.slice(0, 15))) {
      return {
        entryId: entry.id,
        label: entry.label,
        priority: entry.priority,
        expected: `Should use: ${required}`,
        description: `Memory rule "${entry.label}" requires using "${required}", but it was not found in the output.`
      }
    }
  }

  return null
}

/**
 * Generate a verification report string.
 */
export function formatVerificationReport(result: VerificationResult): string {
  if (result.passed) {
    return `Verification passed. Checked ${result.checkedCount} memory rules.`
  }

  const lines: string[] = [
    `Verification FAILED. ${result.violations.length} violation(s) found out of ${result.checkedCount} rules checked:`,
    ''
  ]

  for (const v of result.violations) {
    lines.push(`- **[${v.priority.toUpperCase()}] ${v.label}**: ${v.description}`)
    lines.push(`  Expected: ${v.expected}`)
  }

  return lines.join('\n')
}
