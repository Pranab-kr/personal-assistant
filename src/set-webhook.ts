import { env, requireEnv } from './env.js'

const botToken = requireEnv('TELEGRAM_BOT_TOKEN')
const telegramWebhookSecret = requireEnv('TELEGRAM_WEBHOOK_SECRET')
const triggerWebhookSecret = env.triggerWebhookSecret ?? telegramWebhookSecret
const triggerSecretKey = requireEnv('TRIGGER_SECRET_KEY')
const endpointId = env.triggerWebhookEndpointId
const appBaseUrl = requireEnv('APP_BASE_URL')

if (!/^https:\/\/.+/.test(appBaseUrl)) {
  throw new Error('APP_BASE_URL must be an https:// URL (for example https://your-app.up.railway.app)')
}

if (!/^[A-Za-z0-9_-]{1,256}$/.test(telegramWebhookSecret)) {
  throw new Error(
    'TELEGRAM_WEBHOOK_SECRET must be 1-256 characters of A-Z, a-z, 0-9, "_" or "-"'
  )
}

async function setTriggerEndpointSecret(): Promise<void> {
  const response = await fetch(
    `${env.triggerApiUrl}/api/v1/webhooks/endpoints/${endpointId}/secret`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${triggerSecretKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ secret: triggerWebhookSecret })
    }
  )

  if (!response.ok) {
    throw new Error(
      `Failed to set the Trigger.dev endpoint secret for "${endpointId}": HTTP ${response.status}`
    )
  }
}

async function setTelegramWebhook(url: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      secret_token: telegramWebhookSecret,
      allowed_updates: ['message'],
      drop_pending_updates: false
    })
  })

  const data = (await response.json()) as { ok: boolean; description?: string }

  if (!response.ok || !data.ok) {
    throw new Error(`Failed to set webhook: ${data.description ?? `HTTP ${response.status}`}`)
  }
}

const honoWebhookUrl = `${appBaseUrl}/webhooks/telegram`

await setTriggerEndpointSecret()
await setTelegramWebhook(honoWebhookUrl)

console.log(`Trigger.dev endpoint "${endpointId}" secret synced`)
console.log(`Telegram webhook set to ${honoWebhookUrl}`)
