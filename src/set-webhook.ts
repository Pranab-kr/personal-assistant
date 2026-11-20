import { env } from './env.js'

const endpointId = process.env.TRIGGER_WEBHOOK_ENDPOINT_ID?.trim() || 'telegram'

if (!env.telegramWebhookSecret) {
  throw new Error('Missing required environment variable: TELEGRAM_WEBHOOK_SECRET')
}

if (!/^[A-Za-z0-9_-]{1,256}$/.test(env.telegramWebhookSecret)) {
  throw new Error(
    'TELEGRAM_WEBHOOK_SECRET must be 1-256 characters of A-Z, a-z, 0-9, "_" or "-"'
  )
}

type EndpointListResponse = {
  data: Array<{ declaredId: string; url: string }>
}

async function triggerApi(path: string, init?: RequestInit): Promise<Response> {
  if (!env.triggerSecretKey) {
    throw new Error('Missing required environment variable: TRIGGER_SECRET_KEY')
  }

  return fetch(`${env.triggerApiUrl}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.triggerSecretKey}`,
      'Content-Type': 'application/json',
      ...init?.headers
    }
  })
}

async function resolveWebhookUrl(): Promise<string> {
  const response = await triggerApi('/webhooks/endpoints')

  if (!response.ok) {
    throw new Error(`Failed to list Trigger.dev webhook endpoints: HTTP ${response.status}`)
  }

  const { data } = (await response.json()) as EndpointListResponse
  const endpoint = data.find((item) => item.declaredId === endpointId)

  if (!endpoint) {
    throw new Error(
      `Trigger.dev endpoint "${endpointId}" was not found. Run "npx trigger.dev@latest dev" or deploy first.`
    )
  }

  return endpoint.url
}

async function setTriggerEndpointSecret(): Promise<void> {
  const response = await triggerApi(`/webhooks/endpoints/${endpointId}/secret`, {
    method: 'PUT',
    body: JSON.stringify({ secret: env.telegramWebhookSecret })
  })

  if (!response.ok) {
    throw new Error(
      `Failed to set the Trigger.dev endpoint secret for "${endpointId}": HTTP ${response.status}`
    )
  }
}

async function setTelegramWebhook(url: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      secret_token: env.telegramWebhookSecret,
      allowed_updates: ['message'],
      drop_pending_updates: true
    })
  })

  const data = (await response.json()) as { ok: boolean; description?: string }

  if (!response.ok || !data.ok) {
    throw new Error(`Failed to set webhook: ${data.description ?? `HTTP ${response.status}`}`)
  }
}

const webhookUrl = await resolveWebhookUrl()

await setTriggerEndpointSecret()
await setTelegramWebhook(webhookUrl)

console.log(`Telegram webhook set to ${webhookUrl}`)
