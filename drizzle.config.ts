import { existsSync } from "node:fs"
import { loadEnvFile } from "node:process"
import { defineConfig } from "drizzle-kit"

if (existsSync(".env")) {
  loadEnvFile(".env")
}

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL

if (!url) {
  throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set")
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url }
})
