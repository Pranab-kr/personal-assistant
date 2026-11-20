import { bigint, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

export const channelPlatforms = ["telegram"] as const

export type ChannelPlatform = (typeof channelPlatforms)[number]

export const channelIdentifiers = pgTable(
  "channel_identifiers",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    platform: text("platform").$type<ChannelPlatform>().notNull(),
    externalId: text("external_id").notNull(),
    clerkUserId: text("clerk_user_id").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("channel_identifiers_platform_external_id_idx").on(
      table.platform,
      table.externalId
    )
  ]
)

export type ChannelIdentifier = typeof channelIdentifiers.$inferSelect
export type NewChannelIdentifier = typeof channelIdentifiers.$inferInsert
