import { timingSafeEqual } from 'node:crypto'
import { generateText } from 'ai'
import { Hono } from 'hono'
import { model } from './ai.js'
import { env } from './env.js'

type TelegramUser = {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}

type TelegramChat = {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
}

type TelegramMessage = {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
}

type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
}

type TelegramApiResponse<T> = {
  ok: boolean
  result?: T
  description?: string
}

const telegramApi = `https://api.telegram.org/bot${env.telegramBotToken}`

async function callTelegram<T>(method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${telegramApi}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })

  const data = (await response.json()) as TelegramApiResponse<T>

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description ?? `HTTP ${response.status}`}`)
  }

  return data.result as T
}

function matchesSecret(provided: string | undefined): boolean {
  if (!provided) {
    return false
  }

  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(env.telegramWebhookSecret)

  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  )
}

const telegram = new Hono()

telegram.post('/webhook', async (c) => {
  const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token')

  if (!matchesSecret(secret)) {
    return c.json({ ok: false, error: 'Unauthorized' }, 401)
  }

  const update = await c.req.json<TelegramUpdate>()

  if (update.message?.text) {
    const { text } = await generateText({
      model,
      prompt: update.message.text
    })

    await callTelegram<TelegramMessage>('sendMessage', {
      chat_id: update.message.chat.id,
      text: text.slice(0, 4096)
    })
  }

  return c.json({ ok: true })
})

export default telegram
