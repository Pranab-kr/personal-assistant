import { env, requireEnv } from './env.js'

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const DEFAULT_SCOPES = 'openid profile email'

export type ClerkDeviceAuthStart = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export type ClerkDeviceTokenPollResult =
  | { status: 'approved'; accessToken: string }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'denied' }
  | { status: 'expired' }

export type ClerkUserInfo = {
  clerkUserId: string
  email?: string
  name?: string
}

export function resolveClerkFrontendApiUrl(): string {
  if (env.clerkFrontendApiUrl) {
    return env.clerkFrontendApiUrl
  }

  const publishableKey = requireEnv('CLERK_PUBLISHABLE_KEY')
  const match = publishableKey.match(/^pk_(?:test|live)_(.+)$/)

  if (!match) {
    throw new Error('CLERK_PUBLISHABLE_KEY must start with "pk_test_" or "pk_live_"')
  }

  const decoded = Buffer.from(match[1], 'base64').toString('utf8').replace(/\$+$/, '').trim()

  if (!decoded || decoded.includes('/')) {
    throw new Error(
      'Could not derive Clerk Frontend API host from CLERK_PUBLISHABLE_KEY. Set CLERK_FRONTEND_API_URL explicitly.'
    )
  }

  return `https://${decoded}`
}

function oauthClientCredentials(): { clientId: string; clientSecret?: string } {
  return {
    clientId: requireEnv('CLERK_OAUTH_CLIENT_ID'),
    clientSecret: env.clerkOAuthClientSecret
  }
}

export async function startDeviceAuthorization(): Promise<ClerkDeviceAuthStart> {
  const baseUrl = resolveClerkFrontendApiUrl()
  const { clientId, clientSecret } = oauthClientCredentials()

  const body = new URLSearchParams({
    client_id: clientId,
    scope: DEFAULT_SCOPES
  })

  if (clientSecret) {
    body.set('client_secret', clientSecret)
  }

  const response = await fetch(`${baseUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })

  const raw = await response.text()

  if (!response.ok) {
    throw new Error(
      `Clerk device authorization failed (HTTP ${response.status}): ${raw.slice(0, 300)}`
    )
  }

  const data = JSON.parse(raw) as {
    device_code?: string
    user_code?: string
    verification_uri?: string
    verification_uri_complete?: string
    expires_in?: number
    interval?: number
  }

  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error('Clerk device authorization response is missing required fields')
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete ?? data.verification_uri,
    expiresIn: data.expires_in ?? 600,
    interval: Math.max(data.interval ?? 5, 5)
  }
}

export async function pollDeviceTokenOnce(deviceCode: string): Promise<ClerkDeviceTokenPollResult> {
  const baseUrl = resolveClerkFrontendApiUrl()
  const { clientId, clientSecret } = oauthClientCredentials()

  const body = new URLSearchParams({
    grant_type: DEVICE_GRANT_TYPE,
    device_code: deviceCode,
    client_id: clientId
  })

  if (clientSecret) {
    body.set('client_secret', clientSecret)
  }

  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })

  const raw = await response.text()

  if (response.ok) {
    const data = JSON.parse(raw) as { access_token?: string }

    if (!data.access_token) {
      throw new Error('Clerk token endpoint returned 200 without access_token')
    }

    return { status: 'approved', accessToken: data.access_token }
  }

  let errorCode: string | undefined
  let errorDescription: string | undefined

  try {
    const parsed = JSON.parse(raw) as { error?: string; error_description?: string }
    errorCode = parsed.error
    errorDescription = parsed.error_description
  } catch {
    // Non-JSON error body
  }

  if (errorCode === 'authorization_pending') {
    return { status: 'pending' }
  }

  if (errorCode === 'slow_down') {
    return { status: 'slow_down' }
  }

  if (errorCode === 'access_denied') {
    return { status: 'denied' }
  }

  if (errorCode === 'expired_token') {
    return { status: 'expired' }
  }

  throw new Error(
    `Clerk device token poll failed (HTTP ${response.status}): ${errorCode ?? raw.slice(0, 200)}${
      errorDescription ? ` — ${errorDescription}` : ''
    }`
  )
}

export async function fetchClerkUserInfo(accessToken: string): Promise<ClerkUserInfo> {
  const baseUrl = resolveClerkFrontendApiUrl()

  const response = await fetch(`${baseUrl}/oauth/userinfo`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  })

  const raw = await response.text()

  if (!response.ok) {
    throw new Error(`Clerk userinfo request failed (HTTP ${response.status}): ${raw.slice(0, 300)}`)
  }

  const data = JSON.parse(raw) as {
    sub?: string
    email?: string
    name?: string
  }

  if (!data.sub?.trim()) {
    throw new Error('Clerk userinfo response did not include a sub (user ID)')
  }

  return {
    clerkUserId: data.sub.trim(),
    email: data.email,
    name: data.name
  }
}
