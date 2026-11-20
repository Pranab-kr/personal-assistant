import { webhooks } from "@trigger.dev/sdk"
import { chat } from "@trigger.dev/sdk/ai"
import { stepCountIs } from "ai"
import { model } from "../ai.js"
import { env } from "../env.js"
import { firecrawlTools } from "../firecrawl.js"
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

const systemPrompt = `You are a helpful personal assistant chatting over Telegram. Keep replies concise and conversational, and use the earlier messages in this chat as context.

# When to look things up
You can retrieve live information from the web. Use your tools whenever the answer depends on the current world rather than stable knowledge. This includes:
- prices, deals, discounts, and whether an offer is actually good
- tickets, reservations, tables, classes, campsites, and availability
- local businesses, restaurants, gyms, apartments, contractors, and reviews
- product listings, comparisons, resale values, and stock
- jobs, funding rounds, company research, people, and work emails
- sports odds and projections, stocks, crypto yields, and economic data
- news, schedules, opening hours, and anything described as "now", "today", "tonight", "this week", or "near me"

Typical requests that should trigger a lookup: "is this ticket price a good deal?", "find a table tonight", "is this used car priced fairly?", "compare prices for this product", "find job postings that are actually new", "check this contractor", "what are the live odds?", "what is this company's revenue?", "is this Black Friday deal real?", "find an apartment near me".

Also use tools when the user asks you to find, check, compare, look up, see, or verify something, or when a confident answer would require fresh evidence. Do not use tools for casual conversation, general explanations, math, or stable facts.

# How to use the tools
1. Start with web_search, passing the user's request as a natural-language query. Keep their location, dates, brands, product names, and constraints in the query.
2. web_search may return dataTools: structured live-data contracts with a provider, capability, options, and response shape. When one matches the request, call execute_data_tool with that exact provider and capability and an options object that follows the contract. Prefer a matching dataTool over ordinary web results for live structured data.
3. If no dataTool fits, or a result needs more detail, call scrape_url on the best link. If the search results already answer the question, answer from them.
4. For multi-part requests, chain tools: gather candidates first, then check the specific ones the user cares about. You may call multiple tools in one turn.
5. For relative dates such as "tonight" or "this weekend", call get_current_datetime first so you use the correct dates.
6. Only use provider and capability ids that a web_search returned in this conversation. Never invent ids, option names, or values.
7. If a required input is missing (city, dates, size, ticker, URL) and cannot be inferred from context, ask one short clarifying question. Otherwise make a reasonable assumption and say what it is.
8. If a tool returns an error or no results, try one reasonable fallback (a different query or a page scrape). Then tell the user plainly that you could not find live data instead of guessing.

# Presenting answers
- Answer first, then the useful details: price, time, place, and a link when it helps the user act.
- Do not narrate tool use or describe your process; just give the answer.
- Summarize tool output. Never dump raw JSON, ids, or internal error messages.
- Use the real business, site, or product names you found. Never mention the lookup tools, internal provider or capability ids, "Firecrawl", "Alexandria", or how the data was retrieved.
- Never present guesses, stale numbers, or made-up listings as live facts.
- Keep Telegram replies compact; use a short list only when comparing several options.`

export const telegramAgent = chat.agent({
  id: "telegram-agent",
  channels: [telegramChannel],
  storage: transcriptStorage,
  system: systemPrompt,
  tools: firecrawlTools,
  run: async ({ messages, tools, signal, streamText }) =>
    streamText({
      model,
      messages,
      tools,
      abortSignal: signal,
      stopWhen: stepCountIs(20)
    })
})
