import { v } from 'convex/values'
import { internalMutation, internalQuery } from './_generated/server'

const profileResult = v.union(
  v.null(),
  v.object({
    authUserId: v.string(),
    email: v.string(),
    displayName: v.string(),
    image: v.optional(v.string()),
    usageJson: v.string(),
    globalMemoriesJson: v.string(),
    updatedAt: v.number()
  })
)

export const userIdForAccountToken = internalQuery({
  args: { tokenHash: v.string(), now: v.number() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query('accountTokens')
      .withIndex('by_token_hash', (query) => query.eq('tokenHash', args.tokenHash))
      .unique()
    return token && token.expiresAt > args.now ? token.authUserId : null
  }
})

export const get = internalQuery({
  args: { authUserId: v.string() },
  returns: profileResult,
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query('accountProfiles')
      .withIndex('by_auth_user_id', (query) => query.eq('authUserId', args.authUserId))
      .unique()
    if (!profile) return null
    return {
      authUserId: profile.authUserId,
      email: profile.email,
      displayName: profile.displayName,
      image: profile.image,
      usageJson: profile.usageJson,
      globalMemoriesJson: profile.globalMemoriesJson,
      updatedAt: profile.updatedAt
    }
  }
})

export const save = internalMutation({
  args: {
    authUserId: v.string(),
    email: v.string(),
    displayName: v.string(),
    image: v.optional(v.string()),
    usageJson: v.string(),
    globalMemoriesJson: v.string(),
    updatedAt: v.number()
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('accountProfiles')
      .withIndex('by_auth_user_id', (query) => query.eq('authUserId', args.authUserId))
      .unique()
    if (existing) {
      await ctx.db.patch(existing._id, args)
      return
    }
    await ctx.db.insert('accountProfiles', args)
  }
})
