import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  accountProfiles: defineTable({
    authUserId: v.string(),
    email: v.string(),
    displayName: v.string(),
    image: v.optional(v.string()),
    memoriesUsedBytes: v.number(),
    memoriesLimitBytes: v.number(),
    updatedAt: v.number()
  }).index('by_auth_user_id', ['authUserId']),

  desktopAuthorizationCodes: defineTable({
    codeHash: v.string(),
    authUserId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number())
  }).index('by_code_hash', ['codeHash']),

  accountTokens: defineTable({
    tokenHash: v.string(),
    authUserId: v.string(),
    expiresAt: v.number(),
    lastUsedAt: v.number()
  })
    .index('by_token_hash', ['tokenHash'])
    .index('by_auth_user_id', ['authUserId']),

  desktops: defineTable({
    authUserId: v.optional(v.string()),
    label: v.string(),
    desktopTokenHash: v.string(),
    profileTokenHash: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.number()
  })
    .index('by_desktop_token_hash', ['desktopTokenHash'])
    .index('by_profile_token_hash', ['profileTokenHash']),

  deviceEnrollments: defineTable({
    enrollmentCodeHash: v.string(),
    desktopId: v.id('desktops'),
    expiresAt: v.number(),
    claimedAt: v.optional(v.number())
  }).index('by_enrollment_code_hash', ['enrollmentCodeHash']),

  mobileDevices: defineTable({
    authUserId: v.string(),
    desktopId: v.id('desktops'),
    label: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.number()
  })
    .index('by_auth_user_id', ['authUserId'])
    .index('by_desktop_id', ['desktopId']),

  auditEvents: defineTable({
    authUserId: v.optional(v.string()),
    desktopId: v.optional(v.id('desktops')),
    event: v.string(),
    metadata: v.optional(v.string()),
    createdAt: v.number()
  })
    .index('by_auth_user_id', ['authUserId'])
    .index('by_desktop_id', ['desktopId'])
})
