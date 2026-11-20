import { createOpenAI } from '@ai-sdk/openai'
import { env } from './env.js'

if (!env.openaiApiKey) {
  throw new Error('Missing required environment variable: OPENAI_API_KEY')
}

if (!env.openaiModel) {
  throw new Error('Missing required environment variable: OPENAI_MODEL')
}

const provider = createOpenAI({
  name: 'xkiro',
  apiKey: env.openaiApiKey,
  baseURL: env.openaiBaseUrl
})

export const model = provider.chat(env.openaiModel)
