import { describe, expect, it } from 'vitest'

import {
  comboboxOptions,
  pickComboboxOption,
  type ComboboxOption
} from '../../../src/main/browser/browser-service/browser-agent-combobox'

/**
 * Choosing from a picker that is not a `<select>`.
 *
 * A portal keeps nothing that was typed into its picker; only a clicked option is a
 * value. What these hold still is the judgement that decides which option that is,
 * and the refusal to invent one when the list does not contain it.
 */

function option(overrides: Partial<ComboboxOption> = {}): ComboboxOption {
  return {
    ref: 'r1',
    label: 'East US',
    value: 'eastus',
    selected: false,
    disabled: false,
    ...overrides
  }
}

describe('combobox options', () => {
  it('reads only options that carry a reference, because only those can be clicked', () => {
    const options = comboboxOptions({
      options: [
        { ref: 'r1', label: 'East US', value: 'eastus' },
        { label: 'West US 2', value: 'westus2' },
        { ref: '', label: 'Empty ref' },
        'not an option'
      ]
    })
    expect(options).toHaveLength(1)
    expect(options[0]).toEqual({
      ref: 'r1',
      label: 'East US',
      value: 'eastus',
      selected: false,
      disabled: false
    })
  })

  it('answers with none when the read reported no list', () => {
    expect(comboboxOptions(null)).toEqual([])
    expect(comboboxOptions({ options: 'none' })).toEqual([])
    expect(comboboxOptions({ found: false })).toEqual([])
  })
})

describe('choosing an option', () => {
  it('prefers an exact label over a partial one', () => {
    const options = [
      option({ ref: 'r1', label: 'East US 2', value: 'eastus2' }),
      option({ ref: 'r2', label: 'East US', value: 'eastus' })
    ]
    expect(pickComboboxOption(options, 'East US')?.ref).toBe('r2')
  })

  it('matches a value as well as a label, and ignores case', () => {
    const options = [
      option({ ref: 'r1', label: 'West US 2', value: 'westus2' }),
      option({ ref: 'r2', label: 'East US', value: 'eastus' })
    ]
    expect(pickComboboxOption(options, 'westus2')?.ref).toBe('r1')
    expect(pickComboboxOption(options, 'east us')?.ref).toBe('r2')
  })

  it('falls from a prefix match to a contained match', () => {
    const options = [
      option({ ref: 'r1', label: 'North Europe' }),
      option({ ref: 'r2', label: 'Europe West' })
    ]
    expect(pickComboboxOption(options, 'europe')?.ref).toBe('r2')
    expect(pickComboboxOption(options, 'euro')?.ref).toBe('r2')
  })

  it('never chooses an option the control marked unavailable', () => {
    const options = [option({ ref: 'r1', disabled: true })]
    expect(pickComboboxOption(options, 'East US')).toBeNull()
  })

  it('chooses nothing when the list does not contain the query', () => {
    const options = [
      option({ ref: 'r1', label: 'East US' }),
      option({ ref: 'r2', label: 'West US' })
    ]
    expect(pickComboboxOption(options, 'Brazil South')).toBeNull()
  })

  it('with no query, keeps the current selection or takes the first option', () => {
    const options = [
      option({ ref: 'r1', label: 'East US' }),
      option({ ref: 'r2', label: 'West US', selected: true })
    ]
    expect(pickComboboxOption(options, '')?.ref).toBe('r2')
    expect(pickComboboxOption([option({ ref: 'r1' })], '  ')?.ref).toBe('r1')
  })
})
