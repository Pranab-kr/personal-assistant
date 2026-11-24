import type { UIMessage } from 'ai'
import { requireEnv } from './env.js'

export type TelegramUser = {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}

export type TelegramChat = {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
}

export type TelegramPhotoSize = {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export type TelegramDocument = {
  file_id: string
  file_unique_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export type TelegramMessage = {
  message_id: number
  message_thread_id?: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
  caption?: string
  document?: TelegramDocument
  photo?: TelegramPhotoSize[]
  media_group_id?: string
}

export type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
}

export type AuthenticatedTelegramUpdate = TelegramUpdate & {
  clerkUserId: string
}

export type TelegramHandle = {
  chatId: number
  messageThreadId?: number
}

export type TelegramTarget = TelegramHandle

export type TelegramAttachment = {
  fileId: string
  fileUniqueId: string
  fileName: string
  mediaType: string
  fileSize?: number
  sandboxPath: string
}

type TelegramApiResponse<T> = {
  ok: boolean
  result?: T
  description?: string
}

type TelegramFile = {
  file_id: string
  file_unique_id: string
  file_size?: number
  file_path?: string
}

export const TELEGRAM_UPLOAD_DIR = 'uploads'
export const MAX_TELEGRAM_DOWNLOAD_BYTES = 20 * 1024 * 1024
export const MAX_TELEGRAM_UPLOAD_BYTES = 50 * 1024 * 1024

function telegramApiUrl(): string {
  return `https://api.telegram.org/bot${requireEnv('TELEGRAM_BOT_TOKEN')}`
}

function telegramFileApiUrl(): string {
  return `https://api.telegram.org/file/bot${requireEnv('TELEGRAM_BOT_TOKEN')}`
}

const threadIds = new Map<number, number | undefined>()
const filePaths = new Map<string, string>()
const fileCache = new Map<string, Uint8Array>()

export async function callTelegram<T>(method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${telegramApiUrl()}/${method}`, {
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

export async function sendTelegramMessage(params: {
  chatId: number
  text: string
  messageThreadId?: number
  disableLinkPreview?: boolean
}): Promise<number> {
  const message = await callTelegram<{ message_id: number }>('sendMessage', {
    chat_id: params.chatId,
    text: params.text,
    ...(params.messageThreadId ? { message_thread_id: params.messageThreadId } : {}),
    link_preview_options: { is_disabled: params.disableLinkPreview ?? true }
  })

  return message.message_id
}

async function callTelegramForm<T>(method: string, form: FormData): Promise<T> {
  const response = await fetch(`${telegramApiUrl()}/${method}`, {
    method: 'POST',
    body: form
  })

  const data = (await response.json()) as TelegramApiResponse<T>

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description ?? `HTTP ${response.status}`}`)
  }

  return data.result as T
}

export function rememberTelegramThread(chatId: number, threadId?: number): void {
  threadIds.set(chatId, threadId)
}

export function telegramThreadFor(chatId: number): number | undefined {
  return threadIds.get(chatId)
}

export function sanitizeFileName(name: string, fallback = 'file'): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(-100)

  return cleaned || fallback
}

export function extractAttachments(message: TelegramMessage): {
  attachments: TelegramAttachment[]
  skipped: string[]
} {
  const attachments: TelegramAttachment[] = []
  const skipped: string[] = []

  if (message.document) {
    const document = message.document
    const rawName = document.file_name?.trim() || `document-${document.file_unique_id}`
    const fileName = sanitizeFileName(rawName, `document-${document.file_unique_id}`)

    if (document.file_size && document.file_size > MAX_TELEGRAM_DOWNLOAD_BYTES) {
      skipped.push(fileName)
    } else {
      attachments.push({
        fileId: document.file_id,
        fileUniqueId: document.file_unique_id,
        fileName,
        mediaType: document.mime_type || 'application/octet-stream',
        fileSize: document.file_size,
        sandboxPath: `${TELEGRAM_UPLOAD_DIR}/${fileName}`
      })
    }
  }

  const photo = message.photo?.at(-1)

  if (photo) {
    const fileName = `photo-${photo.file_unique_id}.jpg`

    if (photo.file_size && photo.file_size > MAX_TELEGRAM_DOWNLOAD_BYTES) {
      skipped.push(fileName)
    } else {
      attachments.push({
        fileId: photo.file_id,
        fileUniqueId: photo.file_unique_id,
        fileName,
        mediaType: 'image/jpeg',
        fileSize: photo.file_size,
        sandboxPath: `${TELEGRAM_UPLOAD_DIR}/${fileName}`
      })
    }
  }

  return { attachments, skipped }
}

export function collectAttachments(uiMessages: UIMessage[]): TelegramAttachment[] {
  const seen = new Set<string>()
  const attachments: TelegramAttachment[] = []

  for (const message of uiMessages) {
    for (const part of message.parts) {
      if (part.type !== 'data-attachment') {
        continue
      }

      const attachment = part.data as TelegramAttachment | undefined

      if (!attachment?.fileId || seen.has(attachment.fileUniqueId)) {
        continue
      }

      seen.add(attachment.fileUniqueId)
      attachments.push(attachment)
    }
  }

  return attachments
}

export function extractLatestTelegramTarget(uiMessages: UIMessage[]): TelegramTarget | undefined {
  for (let i = uiMessages.length - 1; i >= 0; i--) {
    const message = uiMessages[i]

    for (let j = message.parts.length - 1; j >= 0; j--) {
      const part = message.parts[j]

      if (part.type !== 'data-telegram-target') {
        continue
      }

      const target = part.data as Partial<TelegramTarget> | undefined

      if (typeof target?.chatId === 'number' && Number.isFinite(target.chatId)) {
        return {
          chatId: target.chatId,
          ...(typeof target.messageThreadId === 'number'
            ? { messageThreadId: target.messageThreadId }
            : {})
        }
      }
    }

    const metadata = message.metadata as { externalUserId?: unknown } | undefined
    const externalUserId = metadata?.externalUserId

    if (typeof externalUserId === 'string' && /^\d+$/.test(externalUserId)) {
      return { chatId: Number(externalUserId) }
    }
  }

  return undefined
}

export function describeAttachments(attachments: TelegramAttachment[]): string {
  return attachments.map((attachment) => `${attachment.fileName} -> ${attachment.sandboxPath}`).join('\n')
}

export function telegramFileUrl(attachment: TelegramAttachment): string {
  const url = new URL(`https://api.telegram.org/file/${encodeURIComponent(attachment.fileId)}`)
  url.searchParams.set('filename', attachment.fileName)
  url.searchParams.set('mediaType', attachment.mediaType)

  return url.toString()
}

export function telegramFileIdFromUrl(url: URL): string | null {
  if (url.hostname !== 'api.telegram.org' || !url.pathname.startsWith('/file/')) {
    return null
  }

  const encoded = url.pathname.slice('/file/'.length)

  return encoded ? decodeURIComponent(encoded) : null
}

async function getTelegramFilePath(fileId: string): Promise<string> {
  const cached = filePaths.get(fileId)

  if (cached) {
    return cached
  }

  const file = await callTelegram<TelegramFile>('getFile', { file_id: fileId })

  if (!file.file_path) {
    throw new Error('Telegram getFile did not return a file path')
  }

  filePaths.set(fileId, file.file_path)

  return file.file_path
}

export async function downloadTelegramFile(fileId: string): Promise<Uint8Array> {
  const cached = fileCache.get(fileId)

  if (cached) {
    return cached
  }

  const filePath = await getTelegramFilePath(fileId)
  const response = await fetch(`${telegramFileApiUrl()}/${filePath}`)

  if (!response.ok) {
    throw new Error(`Telegram file download failed: HTTP ${response.status}`)
  }

  const data = new Uint8Array(await response.arrayBuffer())

  fileCache.set(fileId, data)

  if (fileCache.size > 32) {
    const oldest = fileCache.keys().next().value

    if (oldest) {
      fileCache.delete(oldest)
    }
  }

  return data
}

export async function sendTelegramFile(params: {
  chatId: number
  threadId?: number
  bytes: Uint8Array
  fileName: string
  mediaType: string
  caption?: string
}): Promise<{ messageId: number; method: 'sendDocument' | 'sendPhoto' }> {
  const { bytes, fileName, mediaType } = params

  if (bytes.byteLength > MAX_TELEGRAM_UPLOAD_BYTES) {
    throw new Error(
      `File is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; Telegram bots can upload at most 50 MB.`
    )
  }

  const form = new FormData()
  form.append('chat_id', String(params.chatId))

  if (params.threadId) {
    form.append('message_thread_id', String(params.threadId))
  }

  if (params.caption?.trim()) {
    form.append('caption', params.caption.trim().slice(0, 1024))
  }

  const blob = new Blob([new Uint8Array(bytes)], { type: mediaType || 'application/octet-stream' })
  const usePhoto = mediaType.startsWith('image/') && bytes.byteLength <= 10 * 1024 * 1024

  if (usePhoto) {
    form.append('photo', blob, fileName)
  } else {
    form.append('document', blob, fileName)
  }

  const result = await callTelegramForm<{ message_id: number }>(
    usePhoto ? 'sendPhoto' : 'sendDocument',
    form
  )

  return { messageId: result.message_id, method: usePhoto ? 'sendPhoto' : 'sendDocument' }
}
