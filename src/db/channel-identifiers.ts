import { and, eq } from "drizzle-orm"
import { getDb } from "./index.js"
import { channelIdentifiers, type ChannelPlatform } from "./schema.js"

export async function findClerkUserIdByChannel(
  platform: ChannelPlatform,
  externalId: string
): Promise<string | null> {
  const rows = await getDb()
    .select({ clerkUserId: channelIdentifiers.clerkUserId })
    .from(channelIdentifiers)
    .where(
      and(
        eq(channelIdentifiers.platform, platform),
        eq(channelIdentifiers.externalId, externalId)
      )
    )
    .limit(1)

  return rows[0]?.clerkUserId ?? null
}

export async function findClerkUserIdByTelegramId(
  telegramUserId: string
): Promise<string | null> {
  return findClerkUserIdByChannel("telegram", telegramUserId)
}

export async function upsertTelegramChannelIdentifier(params: {
  telegramUserId: string
  clerkUserId: string
}): Promise<void> {
  await getDb()
    .insert(channelIdentifiers)
    .values({
      platform: "telegram",
      externalId: params.telegramUserId,
      clerkUserId: params.clerkUserId
    })
    .onConflictDoUpdate({
      target: [channelIdentifiers.platform, channelIdentifiers.externalId],
      set: {
        clerkUserId: params.clerkUserId,
        linkedAt: new Date()
      }
    })
}
