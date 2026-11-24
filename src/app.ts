import { timingSafeEqual } from 'node:crypto'
import { configure, idempotencyKeys, tasks } from '@trigger.dev/sdk'
import { Hono } from 'hono'
import { startDeviceAuthorization, type ClerkDeviceAuthStart } from './clerk-device-auth.js'
import { findClerkUserIdByTelegramId } from './db/channel-identifiers.js'
import { env, requireEnv } from './env.js'
import {
  sendTelegramMessage,
  type AuthenticatedTelegramUpdate,
  type TelegramUpdate
} from './telegram-files.js'
import type { linkTelegramAccount } from './trigger/link-telegram-account.js'

type TriggerEndpointListResponse = {
  data: Array<{ declaredId: string; url: string }>
}

type PendingDeviceChallenge = {
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresAt: number
}

export type AppDependencies = {
  getTelegramWebhookSecret: () => string | undefined
  findClerkUserIdByTelegramId: (telegramUserId: string) => Promise<string | null>
  forwardToTriggerWebhook: (payload: AuthenticatedTelegramUpdate) => Promise<void>
  startDeviceAuthorization: () => Promise<ClerkDeviceAuthStart>
  triggerLinkAccountTask: (payload: {
    telegramUserId: string
    telegramChatId: number
    deviceCode: string
    expiresIn: number
    interval: number
    userCode: string
  }) => Promise<void>
  sendTelegramMessage: (params: {
    chatId: number
    text: string
    messageThreadId?: number
  }) => Promise<number>
}

const MIN_PENDING_REUSE_MS = 90_000

let cachedTriggerWebhookUrl: string | undefined

async function resolveTriggerWebhookUrl(): Promise<string> {
  if (env.triggerTelegramWebhookUrl) {
    return env.triggerTelegramWebhookUrl
  }

  if (cachedTriggerWebhookUrl) {
    return cachedTriggerWebhookUrl
  }

  const secretKey = requireEnv('TRIGGER_SECRET_KEY')
  const endpointId = env.triggerWebhookEndpointId

  const response = await fetch(`${env.triggerApiUrl}/api/v1/webhooks/endpoints`, {
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json'
    }
  })

  if (!response.ok) {
    throw new Error(`Failed to resolve Trigger.dev webhook endpoint: HTTP ${response.status}`)
  }

  const { data } = (await response.json()) as TriggerEndpointListResponse
  const endpoint = data.find((item) => item.declaredId === endpointId)

  if (!endpoint?.url) {
    throw new Error(
      `Trigger.dev webhook endpoint "${endpointId}" was not found. Deploy Trigger.dev tasks first or set TRIGGER_TELEGRAM_WEBHOOK_URL.`
    )
  }

  cachedTriggerWebhookUrl = endpoint.url
  return endpoint.url
}

async function defaultForwardToTriggerWebhook(
  payload: AuthenticatedTelegramUpdate
): Promise<void> {
  const url = await resolveTriggerWebhookUrl()
  const forwardSecret = env.triggerWebhookSecret ?? requireEnv('TELEGRAM_WEBHOOK_SECRET')

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': forwardSecret
    },
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Trigger.dev webhook rejected forwarded update (HTTP ${response.status}): ${body.slice(0, 300)}`
    )
  }
}

let triggerConfigured = false

function ensureTriggerConfigured(): void {
  if (triggerConfigured) {
    return
  }

  configure({
    baseURL: env.triggerApiUrl,
    accessToken: requireEnv('TRIGGER_SECRET_KEY'),
    // Prevent @trigger.dev/sdk from reading Vercel's VERCEL_GIT_COMMIT_REF ("main")
    // and sending an invalid x-trigger-branch header on non-branched dev/prod envs.
    previewBranch: process.env.TRIGGER_PREVIEW_BRANCH?.trim() ?? ''
  })

  triggerConfigured = true
}

async function defaultTriggerLinkAccountTask(payload: {
  telegramUserId: string
  telegramChatId: number
  deviceCode: string
  expiresIn: number
  interval: number
  userCode: string
}): Promise<void> {
  ensureTriggerConfigured()

  const idempotencyKey = await idempotencyKeys.create(
    `link-telegram:${payload.telegramUserId}:${payload.userCode}`,
    { scope: 'global' }
  )

  await tasks.trigger<typeof linkTelegramAccount>(
    'link-telegram-account',
    {
      telegramUserId: payload.telegramUserId,
      telegramChatId: payload.telegramChatId,
      deviceCode: payload.deviceCode,
      expiresIn: payload.expiresIn,
      interval: payload.interval
    },
    {
      idempotencyKey,
      idempotencyKeyTTL: '15m'
    }
  )
}

function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) {
    return false
  }

  const providedBuf = Buffer.from(provided, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')

  if (providedBuf.length !== expectedBuf.length) {
    return false
  }

  return timingSafeEqual(providedBuf, expectedBuf)
}

function formatConnectAccountReply(challenge: {
  verificationUriComplete: string
  verificationUri: string
  userCode: string
}): string {
  return [
    'Connect your account to start chatting.',
    '',
    'Open this link and sign in with Google to approve access:',
    challenge.verificationUriComplete,
    '',
    `Code: ${challenge.userCode}`,
    `(Or visit ${challenge.verificationUri} and enter the code above.)`
  ].join('\n')
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  return (
    typeof value === 'object' &&
    value !== null &&
    'update_id' in value &&
    typeof (value as { update_id?: unknown }).update_id === 'number'
  )
}

export function createApp(overrides: Partial<AppDependencies> = {}) {
  const deps: AppDependencies = {
    getTelegramWebhookSecret: () => env.telegramWebhookSecret,
    findClerkUserIdByTelegramId,
    forwardToTriggerWebhook: defaultForwardToTriggerWebhook,
    startDeviceAuthorization,
    triggerLinkAccountTask: defaultTriggerLinkAccountTask,
    sendTelegramMessage,
    ...overrides
  }

  const pendingChallenges = new Map<string, PendingDeviceChallenge>()
  const app = new Hono()

  app.get('/', (c) => {
    return c.text('Hello Railway!')
  })

  app.get('/health', (c) => {
    return c.json({ ok: true })
  })

  app.post('/webhooks/telegram', async (c) => {
    const expectedSecret = deps.getTelegramWebhookSecret()

    if (!expectedSecret) {
      console.error('[telegram-webhook] TELEGRAM_WEBHOOK_SECRET is not configured')
      return c.json({ ok: false, error: 'webhook_not_configured' }, 500)
    }

    const providedSecret = c.req.header('x-telegram-bot-api-secret-token')

    if (!secretsMatch(providedSecret, expectedSecret)) {
      return c.json({ ok: false, error: 'unauthorized' }, 401)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'invalid_json' }, 400)
    }

    if (!isTelegramUpdate(body)) {
      return c.json({ ok: false, error: 'invalid_telegram_update' }, 400)
    }

    const message = body.message

    if (!message) {
      return c.json({ ok: true, action: 'ignored', reason: 'no_message' })
    }

    if (message.chat?.type !== 'private') {
      return c.json({ ok: true, action: 'ignored', reason: 'non_private_chat' })
    }

    if (!message.from || message.from.is_bot) {
      return c.json({ ok: true, action: 'ignored', reason: 'invalid_sender' })
    }

    const telegramUserId = String(message.from.id)
    const clerkUserId = await deps.findClerkUserIdByTelegramId(telegramUserId)

    if (clerkUserId) {
      pendingChallenges.delete(telegramUserId)

      try {
        await deps.forwardToTriggerWebhook({
          ...body,
          clerkUserId
        })
      } catch (error) {
        console.error(
          '[telegram-webhook] failed forwarding to Trigger.dev:',
          error instanceof Error ? error.message : String(error)
        )
        return c.json({ ok: false, error: 'upstream_webhook_failed' }, 502)
      }

      return c.json({ ok: true, action: 'forwarded', clerkUserId })
    }

    const now = Date.now()
    let challenge = pendingChallenges.get(telegramUserId)

    if (!challenge || challenge.expiresAt - now < MIN_PENDING_REUSE_MS) {
      const auth = await deps.startDeviceAuthorization()

      await deps.triggerLinkAccountTask({
        telegramUserId,
        telegramChatId: message.chat.id,
        deviceCode: auth.deviceCode,
        expiresIn: auth.expiresIn,
        interval: auth.interval,
        userCode: auth.userCode
      })

      challenge = {
        userCode: auth.userCode,
        verificationUri: auth.verificationUri,
        verificationUriComplete: auth.verificationUriComplete,
        expiresAt: now + auth.expiresIn * 1000
      }

      pendingChallenges.set(telegramUserId, challenge)
    }

    await deps.sendTelegramMessage({
      chatId: message.chat.id,
      text: formatConnectAccountReply(challenge),
      messageThreadId: message.message_thread_id
    })

    return c.json({ ok: true, action: 'auth_required' })
  })

  return app
}

const app = createApp()

export default app
