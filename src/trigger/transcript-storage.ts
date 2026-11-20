import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { reduceTranscriptChanges } from "@trigger.dev/sdk/ai"
import type {
  TranscriptCursors,
  TranscriptLoadOptions,
  TranscriptLoadResult,
  TranscriptScope,
  TranscriptState,
  TranscriptStorage,
  TranscriptStorageContext
} from "@trigger.dev/sdk/ai"
import type { UIMessage } from "ai"

type StoredTranscript = TranscriptState & {
  chatId: string
  cursors?: TranscriptCursors
  savedAt: number
}

const cache = new Map<string, StoredTranscript>()
const writeQueues = new Map<string, Promise<void>>()

function storageDir(): string {
  return resolve(process.env.TRANSCRIPT_STORAGE_DIR?.trim() || ".data/transcripts")
}

function fileFor(chatId: string): string {
  const name = createHash("sha256").update(chatId).digest("hex")
  return join(storageDir(), `${name}.json`)
}

async function readTranscript(chatId: string): Promise<StoredTranscript> {
  const cached = cache.get(chatId)

  if (cached) {
    return cached
  }

  try {
    const raw = await readFile(fileFor(chatId), "utf8")
    const parsed = JSON.parse(raw) as StoredTranscript

    if (parsed.chatId !== chatId || !Array.isArray(parsed.entries)) {
      throw new Error(`Invalid transcript file for chat ${chatId}`)
    }

    cache.set(chatId, parsed)
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const empty: StoredTranscript = { chatId, entries: [], state: null, savedAt: 0 }
      cache.set(chatId, empty)
      return empty
    }

    throw error
  }
}

async function writeTranscript(transcript: StoredTranscript): Promise<void> {
  await mkdir(storageDir(), { recursive: true })

  const file = fileFor(transcript.chatId)
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`

  await writeFile(temp, JSON.stringify(transcript), "utf8")
  await rename(temp, file)
}

function enqueue(chatId: string, task: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(chatId) ?? Promise.resolve()
  const next = previous.then(task, task)

  writeQueues.set(chatId, next.catch(() => undefined))
  return next
}

export function createFileTranscriptStorage(): TranscriptStorage {
  return {
    async load<TUIMessage extends UIMessage = UIMessage>(
      scope: TranscriptScope,
      opts?: TranscriptLoadOptions
    ): Promise<TranscriptLoadResult<TUIMessage>> {
      const transcript = await readTranscript(scope.chatId)
      const all = transcript.entries
      let entries = all

      if (opts?.before) {
        const beforeIndex = all.findIndex((entry) => entry.id === opts.before)
        entries = beforeIndex === -1 ? [] : all.slice(0, beforeIndex)
      }

      const limit = opts?.limit && opts.limit > 0 ? opts.limit : undefined

      if (limit) {
        entries = entries.slice(-limit)
      }

      const firstIndex = entries.length > 0 ? all.indexOf(entries[0]) : -1
      const nextCursor = limit && firstIndex > 0 ? entries[0].id : undefined
      const returned = new Set(entries.map((entry) => entry.id))

      return {
        messages: entries.map((entry) => entry.message) as TUIMessage[],
        state: transcript.state,
        cursors: transcript.cursors,
        nextCursor,
        nonFinalIds: transcript.entries
          .filter((entry) => !entry.final && returned.has(entry.id))
          .map((entry) => entry.id)
      }
    },

    async save(ctx: TranscriptStorageContext, changeset): Promise<void> {
      await enqueue(ctx.chatId, async () => {
        const current = await readTranscript(ctx.chatId)
        const next = reduceTranscriptChanges(current, changeset.changes)
        const updated: StoredTranscript = {
          chatId: ctx.chatId,
          entries: next.entries,
          state: next.state,
          cursors: changeset.cursors ?? current.cursors,
          savedAt: Date.now()
        }

        cache.set(ctx.chatId, updated)
        await writeTranscript(updated)
      })
    }
  }
}
