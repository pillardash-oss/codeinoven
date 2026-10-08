import { describe, expect, it } from 'vitest'
import {
  activeModelProfile,
  applyModelProfile,
  isUsableModelProfile,
  MAX_MODEL_PROFILES,
  modelProfileAccountId,
  modelProfileIdFromLabel,
  uniqueModelProfileId,
  usableModelProfiles
} from '../../src/lib/model-profiles'
import type {
  ModelProfile,
  ProviderCatalog,
  ProviderModel,
  ThreadSettings
} from '../../src/lib/types'

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'deep-review',
    name: 'Deep review',
    harnessId: 'opencode',
    providerId: 'anthropic',
    modelId: 'claude-opus-4-8',
    thinkingLevel: 'high',
    inferenceMode: 'normal',
    permissionLevel: 'full_access',
    ...overrides
  }
}

function settings(overrides: Partial<ThreadSettings> = {}): ThreadSettings {
  return {
    harnessId: 'opencode',
    providerId: 'anthropic',
    modelId: 'claude-opus-4-8',
    accountId: 'opencode.default',
    thinkingLevel: 'high',
    permissionLevel: 'auto_review',
    ...overrides
  } as ThreadSettings
}

function model(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id: 'claude-opus-4-8',
    providerId: 'anthropic',
    name: 'Claude Opus 4.8',
    reasoning: true,
    attachment: false,
    toolcall: true,
    ...overrides
  }
}

function catalog(overrides: Partial<ProviderCatalog> = {}): ProviderCatalog {
  return {
    id: 'anthropic',
    harnessId: 'opencode',
    name: 'Anthropic',
    models: [
      model({
        fastSupported: true,
        contextWindows: [200_000, 1_000_000],
        contextWindow: 200_000
      })
    ],
    ...overrides
  }
}

describe('profile ids', () => {
  it('slugifies a typed name into a handle', () => {
    expect(modelProfileIdFromLabel('Deep Review')).toBe('deep-review')
    expect(modelProfileIdFromLabel('  Ship it!!  ')).toBe('ship-it')
  })

  it('falls back to a usable handle when nothing is sluggable', () => {
    expect(modelProfileIdFromLabel('***')).toBe('profile')
    expect(modelProfileIdFromLabel('')).toBe('profile')
  })

  it('suffixes a second profile with the same name so ids stay unique', () => {
    const existing = [profile({ id: 'deep-review' })]
    expect(uniqueModelProfileId(existing, 'Deep review')).toBe('deep-review-2')
    expect(
      uniqueModelProfileId([...existing, profile({ id: 'deep-review-2' })], 'Deep review')
    ).toBe('deep-review-3')
  })
})

describe('usability', () => {
  it('accepts a complete profile', () => {
    expect(isUsableModelProfile(profile())).toBe(true)
  })

  it('refuses a profile that does not name a harness, provider, and model', () => {
    expect(isUsableModelProfile(profile({ modelId: '' }))).toBe(false)
    expect(isUsableModelProfile(profile({ providerId: '' }))).toBe(false)
    expect(isUsableModelProfile(profile({ harnessId: '' }))).toBe(false)
  })

  it('drops unusable rows rather than offering a broken one', () => {
    const rows = [profile(), profile({ id: 'broken', modelId: '' })]
    expect(usableModelProfiles(rows).map((row) => row.id)).toEqual(['deep-review'])
    expect(usableModelProfiles(undefined)).toEqual([])
  })
})

describe('modelProfileAccountId', () => {
  it('keeps the selected account while the harness is unchanged', () => {
    expect(
      modelProfileAccountId(profile(), {
        harnessId: 'opencode',
        accountId: 'opencode.work'
      })
    ).toBe('opencode.work')
  })

  it('falls back to the harness default when the same harness has no account yet', () => {
    expect(modelProfileAccountId(profile(), { harnessId: 'opencode', accountId: undefined })).toBe(
      'opencode.default'
    )
  })

  it('uses the target harness default when the profile crosses harnesses', () => {
    expect(
      modelProfileAccountId(profile({ harnessId: 'codex', providerId: 'openai' }), {
        harnessId: 'opencode',
        accountId: 'opencode.work'
      })
    ).toBe('codex.default')
  })

  it('takes no account for a custom base URL provider', () => {
    expect(
      modelProfileAccountId(profile({ providerId: 'cio-local-proxy' }), {
        harnessId: 'opencode',
        accountId: 'opencode.work'
      })
    ).toBeUndefined()
  })
})

describe('applyModelProfile', () => {
  it('applies every field the profile stores', () => {
    const applied = applyModelProfile(
      settings({
        modelId: 'claude-sonnet-4-5',
        thinkingLevel: 'low',
        permissionLevel: 'auto_review'
      }),
      profile()
    )
    expect(applied.modelId).toBe('claude-opus-4-8')
    expect(applied.thinkingLevel).toBe('high')
    expect(applied.permissionLevel).toBe('full_access')
  })

  it('applies to a picker-sized record without inventing fields it does not own', () => {
    // A model picker holds a harness, a provider, a model, and whatever it was
    // handed for thinking, speed, and permissions. A profile has to apply to that
    // record exactly as it is: a secondary-agent picker has no thread settings to
    // fill in, and must not gain any.
    const applied = applyModelProfile(
      {
        harnessId: 'opencode',
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        accountId: 'opencode.default',
        thinkingLevel: 'low' as const,
        inferenceMode: 'normal' as const,
        permissionLevel: 'auto_review' as const
      },
      profile()
    )
    expect(applied).toEqual({
      harnessId: 'opencode',
      providerId: 'anthropic',
      modelId: 'claude-opus-4-8',
      accountId: 'opencode.default',
      thinkingLevel: 'high',
      inferenceMode: 'normal',
      permissionLevel: 'full_access'
    })
  })

  it('keeps the stored thinking level when the catalog has not resolved the model', () => {
    // A cold catalog says nothing about the level, so the profile's own choice
    // stands rather than whatever happened to be selected before.
    expect(applyModelProfile(settings({ thinkingLevel: 'low' }), profile()).thinkingLevel).toBe(
      'high'
    )
  })

  it('resolves a stored thinking level the target model cannot run', () => {
    const applied = applyModelProfile(settings(), profile({ thinkingLevel: 'ultra' }), [
      catalog({
        models: [
          model({
            thinkingPresets: [
              { id: 'low', label: 'Low', description: '' },
              { id: 'high', label: 'High', description: '' }
            ]
          })
        ]
      })
    ])
    expect(applied.thinkingLevel).toBe('low')
  })

  it('keeps a stored fast tier only when the target model supports it', () => {
    expect(
      applyModelProfile(settings(), profile({ inferenceMode: 'fast' }), [catalog()]).inferenceMode
    ).toBe('fast')
    expect(
      applyModelProfile(settings(), profile({ inferenceMode: 'fast' }), [
        catalog({ models: [model({ fastSupported: false })] })
      ]).inferenceMode
    ).toBe('normal')
  })

  it('falls back to standard when the target model no longer advertises ultrafast', () => {
    const applied = applyModelProfile(settings(), profile({ inferenceMode: 'ultrafast' }), [
      catalog()
    ])
    expect(applied.inferenceMode).toBe('normal')
  })

  it('carries an explicit context window only when the new model offers it', () => {
    // The window is only carried across a model change, so each case starts on a
    // different model than the profile names.
    expect(
      applyModelProfile(
        settings({ modelId: 'claude-sonnet-4-5', contextWindow: 1_000_000 }),
        profile(),
        [catalog()]
      ).contextWindow
    ).toBe(1_000_000)
    expect(
      applyModelProfile(
        settings({ modelId: 'claude-sonnet-4-5', contextWindow: 272_000 }),
        profile(),
        [catalog()]
      ).contextWindow
    ).toBeUndefined()
  })

  it('restores the saved context window when the model did not change', () => {
    const applied = applyModelProfile(
      settings({ contextWindow: 1_000_000 }),
      profile({ contextWindow: 200_000 }),
      [catalog()]
    )
    expect(applied.contextWindow).toBe(200_000)
  })

  it('restores the saved account while applying', () => {
    const same = applyModelProfile(
      settings({ accountId: 'opencode.work', permissionLevel: 'auto_review' }),
      profile({ accountId: 'opencode.personal' })
    )
    expect(same.accountId).toBe('opencode.personal')

    const crossed = applyModelProfile(
      settings({ accountId: 'opencode.work', modelId: 'other', permissionLevel: 'auto_review' }),
      profile({ harnessId: 'codex', providerId: 'openai', accountId: 'codex.work' })
    )
    expect(crossed.accountId).toBe('codex.work')
  })
})

describe('activeModelProfile', () => {
  it('ticks the profile only once the whole preset is live', () => {
    const rows = [
      profile({ contextWindow: 200_000, accountId: 'opencode.work' }),
      profile({ id: 'long-review', contextWindow: 1_000_000, accountId: 'opencode.work' })
    ]
    expect(
      activeModelProfile(rows, {
        harnessId: 'opencode',
        providerId: 'anthropic',
        modelId: 'claude-opus-4-8',
        thinkingLevel: 'high',
        contextWindow: 1_000_000,
        accountId: 'opencode.work',
        inferenceMode: 'normal',
        permissionLevel: 'full_access'
      })?.id
    ).toBe('long-review')

    expect(
      activeModelProfile(rows, {
        harnessId: 'opencode',
        providerId: 'anthropic',
        modelId: 'claude-opus-4-8',
        thinkingLevel: 'high',
        contextWindow: 1_000_000,
        accountId: 'opencode.work',
        inferenceMode: 'normal',
        permissionLevel: 'auto_review'
      })
    ).toBeNull()
  })

  it('recognises a fast profile by the model id it commits', () => {
    // Claude Code resolves a fast tier by swapping to the `opus` alias, so applying
    // this profile commits a model id that differs from the one it stores.
    expect(
      activeModelProfile(
        [
          profile({
            harnessId: 'claude-code',
            providerId: 'anthropic',
            modelId: 'claude-sonnet-4-5',
            inferenceMode: 'fast'
          })
        ],
        {
          harnessId: 'claude-code',
          providerId: 'anthropic',
          modelId: 'opus',
          thinkingLevel: 'high',
          inferenceMode: 'fast',
          permissionLevel: 'full_access'
        }
      )?.id
    ).toBe('deep-review')
  })

  it('keeps legacy profiles usable without a saved account', () => {
    // A held record carries an account even though the profile does not, so the
    // comparison is written to see past one: this stands in for the composer's own
    // settings, which `activeModelProfile` is never told about.
    const current = {
      harnessId: 'opencode',
      providerId: 'anthropic',
      modelId: 'claude-opus-4-8',
      accountId: 'opencode.work',
      thinkingLevel: 'high' as const,
      inferenceMode: 'normal' as const,
      permissionLevel: 'full_access' as const
    }
    expect(activeModelProfile([profile()], current)?.id).toBe('deep-review')
  })
})

describe('bounds', () => {
  it('caps how many profiles the app will hold', () => {
    expect(MAX_MODEL_PROFILES).toBeGreaterThan(0)
    expect(MAX_MODEL_PROFILES).toBeLessThanOrEqual(64)
  })
})
