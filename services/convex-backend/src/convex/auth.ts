import { createClient, type GenericCtx } from '@convex-dev/better-auth'
import { convex, crossDomain } from '@convex-dev/better-auth/plugins'
import { betterAuth } from 'better-auth/minimal'
import authConfig from './auth.config'
import { components } from './_generated/api'
import type { DataModel } from './_generated/dataModel'

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

export const authComponent = createClient<DataModel>(components.betterAuth)

export const socialProviderConfigured = (provider: 'google' | 'apple'): boolean =>
  provider === 'google'
    ? Boolean(process.env['GOOGLE_OAUTH_CLIENT_ID'] && process.env['GOOGLE_OAUTH_CLIENT_SECRET'])
    : Boolean(process.env['APPLE_OAUTH_CLIENT_ID'] && process.env['APPLE_OAUTH_CLIENT_SECRET'])

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  const googleClientId = process.env['GOOGLE_OAUTH_CLIENT_ID']
  const googleClientSecret = process.env['GOOGLE_OAUTH_CLIENT_SECRET']
  const appleClientId = process.env['APPLE_OAUTH_CLIENT_ID']
  const appleClientSecret = process.env['APPLE_OAUTH_CLIENT_SECRET']

  return betterAuth({
    appName: 'CodeInOven',
    baseURL: requiredEnvironment('SITE_URL'),
    secret: requiredEnvironment('BETTER_AUTH_SECRET'),
    database: authComponent.adapter(ctx),
    trustedOrigins: [requiredEnvironment('SITE_URL'), requiredEnvironment('CONVEX_SITE_URL')],
    advanced: {
      crossSubDomainCookies: {
        enabled: true,
        domain: '.codeinoven.com'
      },
      useSecureCookies: true
    },
    socialProviders: {
      ...(googleClientId && googleClientSecret
        ? { google: { clientId: googleClientId, clientSecret: googleClientSecret } }
        : {}),
      ...(appleClientId && appleClientSecret
        ? { apple: { clientId: appleClientId, clientSecret: appleClientSecret } }
        : {})
    },
    plugins: [convex({ authConfig }), crossDomain({ siteUrl: requiredEnvironment('SITE_URL') })]
  })
}
