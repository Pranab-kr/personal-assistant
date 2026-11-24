import { logger, schemaTask, wait } from "@trigger.dev/sdk"
import { z } from "zod"
import { fetchClerkUserInfo, pollDeviceTokenOnce } from "../clerk-device-auth.js"
import {
  findClerkUserIdByTelegramId,
  upsertTelegramChannelIdentifier
} from "../db/channel-identifiers.js"
import { sendTelegramMessage } from "../telegram-files.js"

const MAX_CONSECUTIVE_POLL_ERRORS = 5

export const linkTelegramAccount = schemaTask({
  id: "link-telegram-account",
  maxDuration: 900,
  retry: {
    maxAttempts: 1
  },
  schema: z.object({
    telegramUserId: z.string().min(1),
    telegramChatId: z.number().int(),
    deviceCode: z.string().min(1),
    expiresIn: z.number().int().positive(),
    interval: z.number().int().positive().default(5)
  }),
  run: async (payload) => {
    const deadline = Date.now() + payload.expiresIn * 1000
    let intervalSeconds = Math.max(payload.interval, 5)
    let consecutiveErrors = 0

    logger.info("Waiting for Clerk device authorization", {
      telegramUserId: payload.telegramUserId,
      expiresIn: payload.expiresIn,
      intervalSeconds
    })

    while (Date.now() < deadline) {
      await wait.for({ seconds: intervalSeconds })

      const existingClerkUserId = await findClerkUserIdByTelegramId(payload.telegramUserId)

      if (existingClerkUserId) {
        logger.info("Telegram account already linked", {
          telegramUserId: payload.telegramUserId,
          clerkUserId: existingClerkUserId
        })
        return { status: "already_linked" as const, clerkUserId: existingClerkUserId }
      }

      let pollResult
      try {
        pollResult = await pollDeviceTokenOnce(payload.deviceCode)
        consecutiveErrors = 0
      } catch (error) {
        consecutiveErrors += 1
        logger.warn("Transient Clerk device poll error", {
          telegramUserId: payload.telegramUserId,
          consecutiveErrors,
          error: error instanceof Error ? error.message : String(error)
        })

        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          throw error
        }

        continue
      }

      if (pollResult.status === "pending") {
        continue
      }

      if (pollResult.status === "slow_down") {
        intervalSeconds += 5
        logger.info("Clerk requested slower device polling", { intervalSeconds })
        continue
      }

      if (pollResult.status === "denied") {
        await sendTelegramMessage({
          chatId: payload.telegramChatId,
          text: "Account connection was declined. Send another message anytime if you want to try again."
        })
        return { status: "denied" as const }
      }

      if (pollResult.status === "expired") {
        await sendTelegramMessage({
          chatId: payload.telegramChatId,
          text: "Your sign-in link expired before it was approved. Send another message to get a fresh link."
        })
        return { status: "expired" as const }
      }

      const userInfo = await fetchClerkUserInfo(pollResult.accessToken)

      await upsertTelegramChannelIdentifier({
        telegramUserId: payload.telegramUserId,
        clerkUserId: userInfo.clerkUserId
      })

      logger.info("Linked Telegram account to Clerk user", {
        telegramUserId: payload.telegramUserId,
        clerkUserId: userInfo.clerkUserId
      })

      await sendTelegramMessage({
        chatId: payload.telegramChatId,
        text: "Your account is connected! Send your message now and I'll be right with you."
      })

      return {
        status: "linked" as const,
        clerkUserId: userInfo.clerkUserId
      }
    }

    const linkedAfterLoop = await findClerkUserIdByTelegramId(payload.telegramUserId)

    if (linkedAfterLoop) {
      return { status: "already_linked" as const, clerkUserId: linkedAfterLoop }
    }

    await sendTelegramMessage({
      chatId: payload.telegramChatId,
      text: "Your sign-in link expired before it was approved. Send another message to get a fresh link."
    })

    return { status: "expired" as const }
  }
})
