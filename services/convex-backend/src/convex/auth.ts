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

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    appName: 'CodeInOven',
    baseURL: requiredEnvironment('CONVEX_SITE_URL'),
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
      google: {
        clientId: requiredEnvironment('GOOGLE_OAUTH_CLIENT_ID'),
        clientSecret: requiredEnvironment('GOOGLE_OAUTH_CLIENT_SECRET')
      },
      apple: {
        clientId: requiredEnvironment('APPLE_OAUTH_CLIENT_ID'),
        clientSecret: requiredEnvironment('APPLE_OAUTH_CLIENT_SECRET')
      }
    },
    plugins: [convex({ authConfig }), crossDomain({ siteUrl: requiredEnvironment('SITE_URL') })]
  })
