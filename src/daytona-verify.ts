import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { Daytona } from '@daytona/sdk'

if (existsSync('.env')) {
  loadEnvFile('.env')
}

const apiKey = process.env.DAYTONA_API_KEY?.trim()

if (!apiKey) {
  throw new Error(
    'DAYTONA_API_KEY is not set. Create an API key at https://app.daytona.io/dashboard/keys and add DAYTONA_API_KEY to .env'
  )
}

const daytona = new Daytona({ apiKey })

console.log('Creating sandbox...')
const sandbox = await daytona.v0.create({
  language: 'python',
  labels: { app: 'personal-assistant', purpose: 'daytona-verify' }
})

console.log(`Sandbox created: ${sandbox.id}`)

try {
  const response = await sandbox.process.codeRun('print("Hello World from Daytona")')

  console.log(`Exit code: ${response.exitCode}`)
  console.log(`Output: ${response.result.trim()}`)

  if (response.exitCode !== 0 || !response.result.includes('Hello World from Daytona')) {
    throw new Error('Hello World did not run as expected')
  }
} finally {
  console.log('Deleting sandbox...')
  await daytona.v0.delete(sandbox, 60, true)
  await daytona.close()
  console.log(`Sandbox deleted: ${sandbox.id}`)
}
