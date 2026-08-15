import { httpRouter } from 'convex/server'
import { httpAction } from './_generated/server'
import { accountProfile, desktopAuthorize, desktopExchange, desktopSignIn } from './account_http'
import { authComponent, createAuth } from './auth'
import { health } from './system'

const http = httpRouter()

authComponent.registerRoutesLazy(http, createAuth, {
  basePath: '/api/auth',
  cors: true,
  trustedOrigins: [process.env['SITE_URL'] ?? 'https://mobile.codeinoven.com']
})

http.route({
  path: '/healthz',
  method: 'GET',
  handler: health
})

http.route({ path: '/desktop/sign-in', method: 'GET', handler: httpAction(desktopSignIn) })
http.route({ path: '/desktop/authorize', method: 'GET', handler: httpAction(desktopAuthorize) })
http.route({
  path: '/v1/desktop-auth/exchange',
  method: 'POST',
  handler: httpAction(desktopExchange)
})
http.route({ path: '/v1/profile', method: 'GET', handler: httpAction(accountProfile) })
http.route({ path: '/v1/profile', method: 'PUT', handler: httpAction(accountProfile) })

export default http
