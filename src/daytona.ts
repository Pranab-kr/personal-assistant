import { posix as pathPosix } from 'node:path'
import { Daytona, type DaytonaV0Client } from '@daytona/sdk'
import { tool } from 'ai'
import { z } from 'zod'
import { env } from './env.js'
import {
  TELEGRAM_UPLOAD_DIR,
  downloadTelegramFile,
  sendTelegramFile,
  telegramThreadFor,
  type TelegramAttachment
} from './telegram-files.js'

type V0Sandbox = Awaited<ReturnType<DaytonaV0Client['create']>>

const MAX_OUTPUT_CHARS = 20_000
const MAX_TIMEOUT_SECONDS = 300
const OUTPUT_DIR = 'outputs'
const SCREENSHOT_DIR = 'screenshots'
const SANDBOX_APP_LABEL = 'personal-assistant'

const daytona = new Daytona({ apiKey: env.daytonaApiKey })

const sandboxPromises = new Map<string, Promise<V0Sandbox>>()
const preparePromises = new Map<string, Promise<void>>()
const preparedSandboxes = new Set<string>()
const uploadedFiles = new Map<string, Set<string>>()
const computerReady = new Set<string>()
const attachmentsByChat = new Map<string, TelegramAttachment[]>()

const mediaTypes: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) {
    return text
  }

  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} characters]`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function inferMediaType(fileName: string): string {
  return mediaTypes[pathPosix.extname(fileName).toLowerCase()] ?? 'application/octet-stream'
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function invalidateIfGone(chatId: string, error: unknown): void {
  const message = errorMessage(error).toLowerCase()

  if (message.includes('destroyed') || message.includes('not found') || message.includes('404')) {
    sandboxPromises.delete(chatId)
  }
}

function toolError(error: unknown) {
  console.error('[daytona] tool error', errorMessage(error))

  return { ok: false as const, error: errorMessage(error) }
}

export function setChatAttachments(chatId: string, attachments: TelegramAttachment[]): void {
  attachmentsByChat.set(chatId, attachments)
}

async function findExistingSandbox(chatId: string): Promise<V0Sandbox | undefined> {
  let found: V0Sandbox | undefined

  for await (const sandbox of daytona.v0.list({
    labels: { app: SANDBOX_APP_LABEL, chatId }
  })) {
    if (sandbox.state === 'destroyed' || sandbox.state === 'destroying') {
      continue
    }

    if (!found || (sandbox.createdAt ?? '') > (found.createdAt ?? '')) {
      found = sandbox
    }
  }

  return found
}

async function startSandbox(sandbox: V0Sandbox): Promise<void> {
  const state = sandbox.state

  if (state === 'started') {
    return
  }

  if (state === 'error' || state === 'build_failed' || state === 'destroyed') {
    throw new Error(`Sandbox ${sandbox.id} is in state ${state}`)
  }

  if (state === 'stopped' || state === 'paused' || state === 'archived') {
    await daytona.v0.start(sandbox, 180)
    return
  }

  await sandbox.waitUntilStarted(180)
}

async function prepareSandbox(sandbox: V0Sandbox): Promise<void> {
  if (preparedSandboxes.has(sandbox.id)) {
    return
  }

  const pending = preparePromises.get(sandbox.id)

  if (pending) {
    return pending
  }

  const promise = (async () => {
    await sandbox.process.executeCommand(
      `mkdir -p ${TELEGRAM_UPLOAD_DIR} ${OUTPUT_DIR} ${SCREENSHOT_DIR}`,
      undefined,
      undefined,
      60
    )

    try {
      const install = await sandbox.process.executeCommand(
        'python3 -m pip install --quiet --disable-pip-version-check pypdf reportlab pillow pymupdf',
        undefined,
        undefined,
        180
      )

      if (install.exitCode !== 0) {
        console.warn('[daytona] dependency install failed:', truncate(install.result, 2000))
      }
    } catch (error) {
      console.warn('[daytona] dependency install failed:', errorMessage(error))
    }

    preparedSandboxes.add(sandbox.id)
  })()

  preparePromises.set(sandbox.id, promise)
  void promise.then(
    () => preparePromises.delete(sandbox.id),
    () => preparePromises.delete(sandbox.id)
  )

  return promise
}

async function stageAttachments(chatId: string, sandbox: V0Sandbox): Promise<void> {
  const attachments = attachmentsByChat.get(chatId) ?? []

  if (attachments.length === 0) {
    return
  }

  let uploaded = uploadedFiles.get(sandbox.id)

  if (!uploaded) {
    uploaded = new Set<string>()
    uploadedFiles.set(sandbox.id, uploaded)
  }

  for (const attachment of attachments) {
    if (uploaded.has(attachment.fileUniqueId)) {
      continue
    }

    try {
      const bytes = await downloadTelegramFile(attachment.fileId)
      await sandbox.fs.uploadFile(Buffer.from(bytes), attachment.sandboxPath)
      uploaded.add(attachment.fileUniqueId)
    } catch (error) {
      console.warn(
        `[daytona] could not stage ${attachment.fileName}:`,
        errorMessage(error)
      )
    }
  }
}

async function createSandbox(chatId: string): Promise<V0Sandbox> {
  return daytona.v0.create(
    {
      language: 'python',
      labels: { app: SANDBOX_APP_LABEL, chatId },
      autoStopInterval: 15,
      autoDeleteInterval: 1440
    },
    { timeout: 180 }
  )
}

export async function ensureSandbox(chatId: string): Promise<V0Sandbox> {
  let promise = sandboxPromises.get(chatId)

  if (!promise) {
    promise = (async () => {
      let sandbox = await findExistingSandbox(chatId)

      if (sandbox) {
        try {
          await startSandbox(sandbox)
        } catch (error) {
          console.warn(
            '[daytona] could not reuse sandbox, creating a new one:',
            errorMessage(error)
          )
          await daytona.v0.delete(sandbox, 60, true).catch(() => undefined)
          sandbox = undefined
        }
      }

      if (!sandbox) {
        sandbox = await createSandbox(chatId)
      }

      await prepareSandbox(sandbox)
      await stageAttachments(chatId, sandbox)

      return sandbox
    })()

    sandboxPromises.set(chatId, promise)
    void promise.catch(() => sandboxPromises.delete(chatId))
  }

  return promise
}

async function ensureComputerUse(sandbox: V0Sandbox): Promise<void> {
  if (computerReady.has(sandbox.id)) {
    return
  }

  const status = await sandbox.computerUse.getStatus()
  const state = status.status?.toLowerCase()

  if (state !== 'started' && state !== 'running') {
    await sandbox.computerUse.start()
  }

  computerReady.add(sandbox.id)
}

export function createDaytonaTools(chatId: string) {
  const numericChatId = Number(chatId)
  const hasTelegramChat = Number.isFinite(numericChatId)

  return {
    sandbox_exec: tool({
      description:
        "Run a shell command inside the user's persistent Daytona sandbox. Use this to install packages, inspect files, or run CLI tools. Paths are relative to the sandbox working directory. Output is truncated.",
      inputSchema: z.object({
        command: z.string().min(1).describe('Shell command to run.'),
        cwd: z.string().optional().describe('Working directory for the command.'),
        timeout: z
          .number()
          .int()
          .min(1)
          .max(MAX_TIMEOUT_SECONDS)
          .default(60)
          .describe('Maximum run time in seconds. Defaults to 60.')
      }),
      execute: async ({ command, cwd, timeout }) => {
        try {
          const sandbox = await ensureSandbox(chatId)
          const response = await sandbox.process.executeCommand(
            command,
            cwd,
            undefined,
            timeout
          )

          return {
            ok: response.exitCode === 0,
            exitCode: response.exitCode,
            output: truncate(response.result ?? '')
          }
        } catch (error) {
          invalidateIfGone(chatId, error)
          return toolError(error)
        }
      }
    }),

    sandbox_python: tool({
      description:
        "Run Python code in the user's persistent Daytona sandbox and return stdout and the exit code. Use this for document processing, data analysis, or any script. pypdf, reportlab, and pillow are preinstalled.",
      inputSchema: z.object({
        code: z.string().min(1).describe('Python source code to execute.'),
        timeout: z
          .number()
          .int()
          .min(1)
          .max(MAX_TIMEOUT_SECONDS)
          .default(60)
          .describe('Maximum run time in seconds. Defaults to 60.')
      }),
      execute: async ({ code, timeout }) => {
        try {
          const sandbox = await ensureSandbox(chatId)
          const response = await sandbox.process.codeRun(code, undefined, timeout)

          return {
            ok: response.exitCode === 0,
            exitCode: response.exitCode,
            output: truncate(response.result ?? '')
          }
        } catch (error) {
          invalidateIfGone(chatId, error)
          return toolError(error)
        }
      }
    }),

    sandbox_list_files: tool({
      description:
        "List files and directories in the user's Daytona sandbox. Use this to discover uploaded files in uploads/ and generated files in outputs/.",
      inputSchema: z.object({
        path: z.string().default('.').describe('Directory to list. Defaults to the working directory.')
      }),
      execute: async ({ path }) => {
        try {
          const sandbox = await ensureSandbox(chatId)
          const files = await sandbox.fs.listFiles(path)

          return {
            ok: true,
            path,
            files: files.slice(0, 200).map((file) => ({
              name: file.name,
              path: file.path,
              size: file.size,
              isDir: file.isDir
            }))
          }
        } catch (error) {
          invalidateIfGone(chatId, error)
          return toolError(error)
        }
      }
    }),

    sandbox_read_file: tool({
      description:
        "Read a text file from the user's Daytona sandbox. Use sandbox_list_files first if you do not know the path. Binary files are rejected; use send_file_to_user to deliver those.",
      inputSchema: z.object({
        path: z.string().min(1).describe('File path in the sandbox.'),
        max_chars: z
          .number()
          .int()
          .min(1)
          .max(50_000)
          .default(20_000)
          .describe('Maximum characters to return. Defaults to 20000.')
      }),
      execute: async ({ path, max_chars }) => {
        try {
          const sandbox = await ensureSandbox(chatId)
          const bytes = await sandbox.fs.downloadFile(path)

          if (bytes.includes(0)) {
            return {
              ok: false,
              error:
                'This looks like a binary file. Use send_file_to_user to send it to the user instead.'
            }
          }

          const text = bytes.toString('utf8')

          return {
            ok: true,
            path,
            size: bytes.byteLength,
            truncated: text.length > max_chars,
            content: truncate(text, max_chars)
          }
        } catch (error) {
          invalidateIfGone(chatId, error)
          return toolError(error)
        }
      }
    }),

    sandbox_write_file: tool({
      description:
        "Create or overwrite a file in the user's Daytona sandbox. Use utf8 for text and base64 for binary content. Put generated files in outputs/ before sending them.",
      inputSchema: z.object({
        path: z.string().min(1).describe('Destination path in the sandbox.'),
        content: z.string().describe('File content.'),
        encoding: z
          .enum(['utf8', 'base64'])
          .default('utf8')
          .describe('Content encoding. Defaults to utf8.')
      }),
      execute: async ({ path, content, encoding }) => {
        try {
          const sandbox = await ensureSandbox(chatId)
          const directory = pathPosix.dirname(path)

          if (directory && directory !== '.') {
            await sandbox.process.executeCommand(`mkdir -p ${shellQuote(directory)}`)
          }

          const bytes =
            encoding === 'base64'
              ? Buffer.from(content, 'base64')
              : Buffer.from(content, 'utf8')

          await sandbox.fs.uploadFile(bytes, path)

          return { ok: true, path, size: bytes.byteLength }
        } catch (error) {
          invalidateIfGone(chatId, error)
          return toolError(error)
        }
      }
    }),

    send_file_to_user: tool({
      description:
        'Send a file from the user\'s Daytona sandbox back to them in Telegram. Use this for every generated document, archive, image, or other file the user asks for. Provide a short caption.',
      inputSchema: z.object({
        path: z.string().min(1).describe('File path inside the sandbox.'),
        caption: z.string().optional().describe('Short caption shown with the file.')
      }),
      execute: async ({ path, caption }) => {
        if (!hasTelegramChat) {
          return { ok: false, error: 'This chat is not a Telegram chat.' }
        }

        try {
          const sandbox = await ensureSandbox(chatId)
          const bytes = await sandbox.fs.downloadFile(path)
          const fileName = pathPosix.basename(path) || 'file'

          const result = await sendTelegramFile({
            chatId: numericChatId,
            threadId: telegramThreadFor(numericChatId),
            bytes,
            fileName,
            mediaType: inferMediaType(fileName),
            caption
          })

          return {
            ok: true,
            path,
            fileName,
            size: bytes.byteLength,
            method: result.method
          }
        } catch (error) {
          invalidateIfGone(chatId, error)
          return toolError(error)
        }
      }
    }),

    computer_action: tool({
      description:
        'Control the Daytona desktop (screenshot, click, move, type, key, scroll). Start with a screenshot so you can see the screen before clicking or typing. Screenshots are also sent to the user in Telegram.',
      inputSchema: z.object({
        action: z
          .enum(['screenshot', 'click', 'move', 'type', 'key', 'scroll'])
          .describe('Action to perform.'),
        x: z.number().int().optional().describe('X coordinate for click, move, or scroll.'),
        y: z.number().int().optional().describe('Y coordinate for click, move, or scroll.'),
        text: z.string().optional().describe('Text to type when action is "type".'),
        key: z
          .string()
          .optional()
          .describe('Key or hotkey to press when action is "key", for example "enter" or "ctrl+c".'),
        direction: z
          .enum(['up', 'down', 'left', 'right'])
          .default('down')
          .describe('Scroll direction. Defaults to down.'),
        amount: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(1)
          .describe('Scroll amount in wheel ticks. Defaults to 1.'),
        button: z
          .enum(['left', 'right', 'middle'])
          .default('left')
          .describe('Mouse button for click. Defaults to left.')
      }),
      execute: async ({ action, x, y, text, key, direction, amount, button }) => {
        if (!hasTelegramChat) {
          return { ok: false, error: 'This chat is not a Telegram chat.' }
        }

        try {
          const sandbox = await ensureSandbox(chatId)
          await ensureComputerUse(sandbox)

          if (action === 'screenshot') {
            const screenshot = await sandbox.computerUse.screenshot.takeCompressed({
              format: 'jpeg',
              quality: 60,
              scale: 0.5,
              showCursor: true
            })
            const base64 = screenshot.screenshot?.replace(/^data:[^;]+;base64,/, '')

            if (!base64) {
              throw new Error('Daytona returned an empty screenshot')
            }

            const bytes = Buffer.from(base64, 'base64')
            const path = `${SCREENSHOT_DIR}/screenshot-${Date.now()}.jpg`

            await sandbox.fs.uploadFile(bytes, path)
            await sendTelegramFile({
              chatId: numericChatId,
              threadId: telegramThreadFor(numericChatId),
              bytes,
              fileName: pathPosix.basename(path),
              mediaType: 'image/jpeg',
              caption: 'Sandbox screenshot'
            })

            return {
              ok: true,
              action,
              path,
              size: bytes.byteLength,
              base64
            }
          }

          if (action === 'click' || action === 'move' || action === 'scroll') {
            if (x == null || y == null) {
              throw new Error(`computer_action "${action}" needs x and y coordinates`)
            }

            if (action === 'click') {
              await sandbox.computerUse.mouse.click(x, y, button)
            } else if (action === 'move') {
              await sandbox.computerUse.mouse.move(x, y)
            } else {
              await sandbox.computerUse.mouse.scroll(x, y, direction, amount)
            }

            return { ok: true, action, x, y, button, direction, amount }
          }

          if (action === 'type') {
            if (!text) {
              throw new Error('computer_action "type" needs text')
            }

            await sandbox.computerUse.keyboard.type(text)

            return { ok: true, action, text }
          }

          if (!key) {
            throw new Error('computer_action "key" needs a key')
          }

          if (key.includes('+')) {
            await sandbox.computerUse.keyboard.hotkey(key)
          } else {
            await sandbox.computerUse.keyboard.press(key)
          }

          return { ok: true, action, key }
        } catch (error) {
          invalidateIfGone(chatId, error)
          return toolError(error)
        }
      },
      toModelOutput: ({ output }) => {
        if (typeof output === 'object' && output !== null && 'base64' in output) {
          const base64 = output.base64

          if (typeof base64 === 'string') {
            return {
              type: 'content' as const,
              value: [
                {
                  type: 'file' as const,
                  mediaType: 'image/jpeg',
                  data: { type: 'data' as const, data: base64 }
                }
              ]
            }
          }
        }

        return {
          type: 'content' as const,
          value: [{ type: 'text' as const, text: JSON.stringify(output) }]
        }
      }
    })
  }
}
