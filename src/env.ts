import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'

if (existsSync('.env')) {
  loadEnvFile('.env')
}

export function readOptionalEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined
}

export function requireEnv(name: string): string {
  const value = readOptionalEnv(name)

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

export const env = {
  get telegramBotToken() {
    return readOptionalEnv('TELEGRAM_BOT_TOKEN')
  },
  get telegramWebhookSecret() {
    return readOptionalEnv('TELEGRAM_WEBHOOK_SECRET')
  },
  get triggerWebhookSecret() {
    return readOptionalEnv('TRIGGER_WEBHOOK_SECRET')
  },
  get triggerSecretKey() {
    return readOptionalEnv('TRIGGER_SECRET_KEY')
  },
  get triggerApiUrl() {
    return (readOptionalEnv('TRIGGER_API_URL') ?? 'https://api.trigger.dev').replace(/\/+$/, '')
  },
  get triggerWebhookEndpointId() {
    return readOptionalEnv('TRIGGER_WEBHOOK_ENDPOINT_ID') ?? 'telegram'
  },
  get triggerTelegramWebhookUrl() {
    return readOptionalEnv('TRIGGER_TELEGRAM_WEBHOOK_URL')
  },
  get appBaseUrl() {
    return readOptionalEnv('APP_BASE_URL')?.replace(/\/+$/, '')
  },
  get databaseUrl() {
    return readOptionalEnv('DATABASE_URL')
  },
  get clerkPublishableKey() {
    return readOptionalEnv('CLERK_PUBLISHABLE_KEY')
  },
  get clerkSecretKey() {
    return readOptionalEnv('CLERK_SECRET_KEY')
  },
  get clerkApiUrl() {
    return (readOptionalEnv('CLERK_API_URL') ?? 'https://api.clerk.com').replace(/\/+$/, '')
  },
  get clerkFrontendApiUrl() {
    return readOptionalEnv('CLERK_FRONTEND_API_URL')?.replace(/\/+$/, '')
  },
  get clerkAccountPortalUrl() {
    return readOptionalEnv('CLERK_ACCOUNT_PORTAL_URL')?.replace(/\/+$/, '')
  },
  get clerkRequiredPlanSlug() {
    return readOptionalEnv('CLERK_REQUIRED_PLAN_SLUG') ?? 'pro'
  },
  get clerkOAuthClientId() {
    return readOptionalEnv('CLERK_OAUTH_CLIENT_ID')
  },
  get clerkOAuthClientSecret() {
    return readOptionalEnv('CLERK_OAUTH_CLIENT_SECRET')
  },
  get openaiApiKey() {
    return readOptionalEnv('OPENAI_API_KEY')
  },
  get openaiBaseUrl() {
    return readOptionalEnv('OPENAI_BASE_URL') ?? 'https://api.xkiro.com/v1'
  },
  get openaiModel() {
    return readOptionalEnv('OPENAI_MODEL')
  },
  get firecrawlApiKey() {
    return readOptionalEnv('FIRECRAWL_API_KEY')
  },
  get daytonaApiKey() {
    return readOptionalEnv('DAYTONA_API_KEY')
  }
}
