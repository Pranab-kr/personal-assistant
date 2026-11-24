import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { requireEnv } from "../env.js"
import * as schema from "./schema.js"

let cachedPool: Pool | undefined
let cachedDb: NodePgDatabase<typeof schema> | undefined

export function getPool(): Pool {
  if (!cachedPool) {
    cachedPool = new Pool({ connectionString: requireEnv("DATABASE_URL") })
  }

  return cachedPool
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!cachedDb) {
    cachedDb = drizzle(getPool(), { schema })
  }

  return cachedDb
}
