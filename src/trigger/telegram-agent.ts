import { webhooks } from "@trigger.dev/sdk"
import { chat } from "@trigger.dev/sdk/ai"
import { stepCountIs } from "ai"
import { model } from "../ai.js"
import { env } from "../env.js"
import { createFileTranscriptStorage } from "./transcript-storage.js"

type TelegramUser = {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}

type TelegramChat = {
  id: number
  type: "private" | "group" | "supergroup" | "channel"
}

type TelegramMessage = {
  message_id: number
  message_thread_id?: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
}

type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
}

type TelegramHandle = {
  chatId: number
  messageThreadId?: number
}

type TelegramApiResponse<T> = {
  ok: boolean
  result?: T
  description?: string
}

const telegramApi = `https://api.telegram.org/bot${env.telegramBotToken}`

async function callTelegram<T>(method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${telegramApi}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })

  const data = (await response.json()) as TelegramApiResponse<T>

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description ?? `HTTP ${response.status}`}`)
  }

  return data.result as T
}

function splitMessage(text: string, limit = 4000): string[] {
  const chunks: string[] = []
  let rest = text.trim()

  while (rest.length > limit) {
    const newline = rest.lastIndexOf("\n", limit)
    const end = newline > limit / 2 ? newline : limit
    chunks.push(rest.slice(0, end))
    rest = rest.slice(end).trimStart()
  }

  if (rest) {
    chunks.push(rest)
  }

  return chunks
}

async function sendTelegramText(handle: TelegramHandle, text: string): Promise<string | undefined> {
  let lastMessageId: string | undefined

  for (const chunk of splitMessage(text)) {
    const message = await callTelegram<{ message_id: number }>("sendMessage", {
      chat_id: handle.chatId,
      text: chunk,
      ...(handle.messageThreadId ? { message_thread_id: handle.messageThreadId } : {}),
      link_preview_options: { is_disabled: true }
    })

    lastMessageId = String(message.message_id)
  }

  return lastMessageId
}

export const telegramEndpoint = webhooks.endpoint.define({
  id: "telegram",
  source: webhooks.custom<TelegramUpdate>(
    {
      scheme: "shared-secret",
      placement: "header",
      fieldName: "x-telegram-bot-api-secret-token",
      idempotencyField: { from: "body", name: "update_id" }
    },
    {
      setupPrompt:
        "Call the Telegram Bot API setWebhook method with the endpoint URL and the same secret as secret_token, and allowed_updates set to [\"message\"]."
    }
  )
})

export const telegramChannel = chat.channels.custom({
  id: "telegram",
  endpoint: telegramEndpoint,
  key: "{event.message.chat.id}",
  filter: "event.message.text != null",
  inbound: (update) => {
    const message = update.message
    const text = message?.text?.trim()

    if (!message || !text) {
      return ""
    }

    return {
      message: text,
      externalUserId: String(message.from?.id ?? message.chat.id),
      externalMessageId: String(message.message_id)
    }
  },
  bind: (update) => {
    const message = update.message

    if (!message) {
      return null
    }

    return {
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id
    }
  },
  outbound: (reply) => (reply.text.trim() ? { text: reply.text } : null),
  send: async (message, ctx) => {
    const handle =
      ctx.handle ?? (ctx.event?.message ? { chatId: ctx.event.message.chat.id } : undefined)

    if (!handle) {
      throw new Error("Telegram channel cannot resolve the chat to reply to")
    }

    return { ref: await sendTelegramText(handle, message.text) }
  },
  errorMessage: "Sorry, I couldn't answer that. Please try again."
})

const transcriptStorage = process.env.TRANSCRIPT_STORAGE_DIR?.trim()
  ? createFileTranscriptStorage()
  : undefined

export const telegramAgent = chat.agent({
  id: "telegram-agent",
  channels: [telegramChannel],
  storage: transcriptStorage,
  system:
    "You are a helpful personal assistant chatting over Telegram. Keep replies concise and conversational, and use the earlier messages in this chat as context.",
  run: async ({ messages, signal, streamText }) =>
    streamText({
      model,
      messages,
      abortSignal: signal,
      stopWhen: stepCountIs(15)
    })
})
