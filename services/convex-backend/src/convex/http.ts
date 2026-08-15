import { httpRouter } from 'convex/server'
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

export default http
