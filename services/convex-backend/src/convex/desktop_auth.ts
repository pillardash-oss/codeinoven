import { v } from 'convex/values'
import { internalMutation } from './_generated/server'

export const createAuthorizationCode = internalMutation({
  args: {
    codeHash: v.string(),
    authUserId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    expiresAt: v.number()
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('desktopAuthorizationCodes', args)
  }
})

export const exchangeAuthorizationCode = internalMutation({
  args: {
    codeHash: v.string(),
    codeChallenge: v.string(),
    redirectUri: v.string(),
    accountTokenHash: v.string(),
    accountTokenExpiresAt: v.number(),
    now: v.number()
  },
  handler: async (ctx, args) => {
    const authorization = await ctx.db
      .query('desktopAuthorizationCodes')
      .withIndex('by_code_hash', (query) => query.eq('codeHash', args.codeHash))
      .unique()

    if (
      !authorization ||
      authorization.consumedAt !== undefined ||
      authorization.expiresAt <= args.now ||
      authorization.codeChallenge !== args.codeChallenge ||
      authorization.redirectUri !== args.redirectUri
    ) {
      return null
    }

    await ctx.db.patch(authorization._id, { consumedAt: args.now })
    await ctx.db.insert('accountTokens', {
      tokenHash: args.accountTokenHash,
      authUserId: authorization.authUserId,
      expiresAt: args.accountTokenExpiresAt,
      lastUsedAt: args.now
    })

    return { authUserId: authorization.authUserId }
  }
})

export const refreshAccountToken = internalMutation({
  args: {
    tokenHash: v.string(),
    replacementTokenHash: v.string(),
    replacementExpiresAt: v.number(),
    now: v.number()
  },
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query('accountTokens')
      .withIndex('by_token_hash', (query) => query.eq('tokenHash', args.tokenHash))
      .unique()
    if (!token || token.expiresAt <= args.now) return false
    await ctx.db.patch(token._id, {
      tokenHash: args.replacementTokenHash,
      expiresAt: args.replacementExpiresAt,
      lastUsedAt: args.now
    })
    return true
  }
})
