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
