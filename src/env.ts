import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'

if (existsSync('.env')) {
  loadEnvFile('.env')
}

const requiredVariables = ['TELEGRAM_BOT_TOKEN', 'DAYTONA_API_KEY'] as const

const missingVariables = requiredVariables.filter((name) => !process.env[name]?.trim())

if (missingVariables.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVariables.join(', ')}`)
}

const readRequired = (name: (typeof requiredVariables)[number]) => process.env[name]!.trim()
const readOptional = (name: string) => process.env[name]?.trim() || undefined

export const env = {
  telegramBotToken: readRequired('TELEGRAM_BOT_TOKEN'),
  telegramWebhookSecret: readOptional('TELEGRAM_WEBHOOK_SECRET'),
  triggerSecretKey: readOptional('TRIGGER_SECRET_KEY'),
  triggerApiUrl: readOptional('TRIGGER_API_URL') ?? 'https://api.trigger.dev',
  openaiApiKey: readOptional('OPENAI_API_KEY'),
  openaiBaseUrl: readOptional('OPENAI_BASE_URL') ?? 'https://api.xkiro.com/v1',
  openaiModel: readOptional('OPENAI_MODEL'),
  firecrawlApiKey: readOptional('FIRECRAWL_API_KEY'),
  daytonaApiKey: readRequired('DAYTONA_API_KEY')
}
