import { httpAction } from './_generated/server'

export const health = httpAction(async () =>
  Response.json(
    { service: 'codeinoven-convex-backend', status: 'ok' },
    { headers: { 'Cache-Control': 'no-store' } }
  )
)
