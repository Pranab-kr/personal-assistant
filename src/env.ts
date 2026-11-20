import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'

if (existsSync('.env')) {
  loadEnvFile('.env')
}

const requiredVariables = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'] as const

const missingVariables = requiredVariables.filter((name) => !process.env[name]?.trim())

if (missingVariables.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVariables.join(', ')}`)
}

const readRequired = (name: (typeof requiredVariables)[number]) => process.env[name]!.trim()

export const env = {
  telegramBotToken: readRequired('TELEGRAM_BOT_TOKEN'),
  telegramWebhookSecret: readRequired('TELEGRAM_WEBHOOK_SECRET')
}
