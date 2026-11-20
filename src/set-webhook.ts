import { env } from './env.js'

const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL?.trim()

if (!webhookUrl) {
  throw new Error('Missing required environment variable: TELEGRAM_WEBHOOK_URL')
}

const response = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: env.telegramWebhookSecret,
    allowed_updates: ['message'],
    drop_pending_updates: true
  })
})

const data = (await response.json()) as { ok: boolean; description?: string }

if (!response.ok || !data.ok) {
  throw new Error(`Failed to set webhook: ${data.description ?? `HTTP ${response.status}`}`)
}

console.log(`Webhook set to ${webhookUrl}`)
