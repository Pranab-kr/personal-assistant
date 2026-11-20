import { Hono } from 'hono'
import testAi from './test-ai.js'

const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Railway!')
})

app.get('/marco', (c) => {
  return c.text('polo')
})

app.route('/test/ai', testAi)

export default app
