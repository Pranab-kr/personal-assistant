import './env.js'
import { serve } from '@hono/node-server'
import app from './app.js'

if (!process.env.VERCEL) {
  serve({
    fetch: app.fetch,
    port: Number(process.env.PORT) || 3000
  }, (info) => {
    console.log(`Server is running on http://localhost:${info.port}`)
  })
}

export default app
