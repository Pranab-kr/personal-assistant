import { webhooks } from "@trigger.dev/sdk"
import { chat } from "@trigger.dev/sdk/ai"
import { stepCountIs, type UIMessage } from "ai"
import { model } from "../ai.js"
import {
  createDaytonaTools,
  setUserAttachments,
  setUserTelegramTarget
} from "../daytona.js"
import { firecrawlTools } from "../firecrawl.js"
import {
  callTelegram,
  collectAttachments,
  describeAttachments,
  downloadTelegramFile,
  extractAttachments,
  extractLatestTelegramTarget,
  rememberTelegramThread,
  telegramFileIdFromUrl,
  telegramFileUrl,
  type AuthenticatedTelegramUpdate,
  type TelegramHandle
} from "../telegram-files.js"
import { createFileTranscriptStorage } from "./transcript-storage.js"

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
  source: webhooks.custom<AuthenticatedTelegramUpdate>(
    {
      scheme: "shared-secret",
      placement: "header",
      fieldName: "x-telegram-bot-api-secret-token",
      idempotencyField: { from: "body", name: "update_id" }
    },
    {
      setupPrompt:
        "Point Telegram's webhook at the Hono /webhooks/telegram route, and forward authenticated private messages here with clerkUserId attached and the shared secret header."
    }
  )
})

export const telegramChannel = chat.channels.custom({
  id: "telegram",
  endpoint: telegramEndpoint,
  key: "{event.clerkUserId}",
  filter:
    "event.clerkUserId != null && event.clerkUserId != '' && event.message != null && event.message.chat.type == 'private' && (event.message.text != null || event.message.caption != null || event.message.document != null || event.message.photo != null)",
  inbound: (update) => {
    const message = update.message

    if (!message || message.chat.type !== "private" || !update.clerkUserId) {
      return ""
    }

    const text = message.text?.trim() || message.caption?.trim() || ""
    const { attachments, skipped } = extractAttachments(message)

    if (!text && attachments.length === 0 && skipped.length === 0) {
      return ""
    }

    rememberTelegramThread(message.chat.id, message.message_thread_id)
    setUserTelegramTarget(update.clerkUserId, {
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id
    })

    const notes: string[] = []

    if (text) {
      notes.push(text)
    }

    if (attachments.length > 0) {
      notes.push(`[Attached files]\n${describeAttachments(attachments)}`)
    }

    if (skipped.length > 0) {
      notes.push(
        `[Not downloaded: ${skipped.join(", ")} — Telegram's 20 MB bot download limit]`
      )
    }

    const parts: UIMessage["parts"] = [
      { type: "text", text: notes.join("\n\n") },
      {
        type: "data-telegram-target",
        data: {
          chatId: message.chat.id,
          ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
        }
      }
    ]

    for (const attachment of attachments) {
      parts.push({ type: "data-attachment", data: attachment })

      if (attachment.mediaType.startsWith("image/")) {
        parts.push({
          type: "file",
          mediaType: attachment.mediaType,
          filename: attachment.fileName,
          url: telegramFileUrl(attachment)
        })
      }
    }

    return {
      message: {
        id: `tg-${message.message_id}`,
        role: "user",
        parts
      },
      externalUserId: String(message.from?.id ?? message.chat.id),
      externalMessageId: String(message.message_id)
    }
  },
  download: async (url) => {
    const fileId = telegramFileIdFromUrl(url)

    if (!fileId) {
      return null
    }

    const data = await downloadTelegramFile(fileId)
    const mediaType = url.searchParams.get("mediaType") || "application/octet-stream"

    return { data, mediaType }
  },
  bind: (update) => {
    const message = update.message

    if (!message || message.chat.type !== "private") {
      return null
    }

    rememberTelegramThread(message.chat.id, message.message_thread_id)

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

# Files, the sandbox, and computer use
Every chat has a persistent Daytona sandbox with Python, pypdf, reportlab, pillow, and PyMuPDF (import pymupdf) preinstalled. Files the user sends are downloaded into uploads/. Put generated files in outputs/.
- Use sandbox_list_files before assuming a path. Use sandbox_read_file for text and sandbox_python or sandbox_exec for processing.
- For PDFs, extract text with pypdf or PyMuPDF. Inspect AcroForm fields with pypdf and fill them with the values the user provides. For flat PDFs, use PyMuPDF search_for to locate labels and insert_text at the returned rectangles, or overlay with reportlab. Add a visible fill (for example a different color or a light box behind the text) when that helps the user see what was added.
- To send a file back, call send_file_to_user with the sandbox path and a short caption. Never claim a file was sent unless the tool succeeded.
- For GUI tasks, use computer_action. Take a screenshot first so you can see the screen, then click, type, or press keys. Coordinates use the screenshot's pixel space.
- Do not invent signatures, identity details, or legal attestations for real documents. For a document clearly marked as a sample or test fixture, placeholder names and typed signature placeholders are fine. For real legal documents, fill only information the user provides and let the user sign.

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
  onTurnStart: async ({ chatId, uiMessages }) => {
    setUserAttachments(chatId, collectAttachments(uiMessages))

    const target = extractLatestTelegramTarget(uiMessages)
    if (target) {
      setUserTelegramTarget(chatId, target)
    }
  },
  tools: (event) => ({
    ...firecrawlTools,
    ...createDaytonaTools(event.chatId)
  }),
  run: async ({ messages, tools, signal, streamText }) =>
    streamText({
      model,
      messages,
      tools,
      abortSignal: signal,
      stopWhen: stepCountIs(20)
    })
})
