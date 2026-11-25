import { resolveClerkFrontendApiUrl } from './clerk-device-auth.js'
import { env, requireEnv } from './env.js'

export const DEFAULT_REQUIRED_PLAN_SLUG = 'pro'

export type ClerkCommercePlan = {
  id?: string
  slug?: string
  name?: string
  for_payer_type?: string
}

export type ClerkCommerceSubscriptionItem = {
  id?: string
  status?: string
  plan?: ClerkCommercePlan | null
}

export type ClerkCommerceSubscription = {
  id?: string
  status?: string
  subscription_items?: ClerkCommerceSubscriptionItem[]
}

type ClerkFapiEnvironment = {
  display_config?: {
    user_profile_url?: string
  }
}

let cachedUserProfileUrl: string | undefined

export function hasActivePlanInSubscription(
  subscription: ClerkCommerceSubscription | null | undefined,
  planSlug: string = DEFAULT_REQUIRED_PLAN_SLUG
): boolean {
  if (!subscription || subscription.status !== 'active') {
    return false
  }

  const items = subscription.subscription_items ?? []

  return items.some(
    (item) =>
      item.status === 'active' &&
      item.plan?.slug === planSlug &&
      (!item.plan.for_payer_type || item.plan.for_payer_type === 'user')
  )
}

export async function userHasActivePlan(
  clerkUserId: string,
  planSlug: string = env.clerkRequiredPlanSlug
): Promise<boolean> {
  const secretKey = requireEnv('CLERK_SECRET_KEY')
  const apiUrl = env.clerkApiUrl

  const response = await fetch(
    `${apiUrl}/v1/users/${encodeURIComponent(clerkUserId)}/billing/subscription`,
    {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json'
      }
    }
  )

  if (response.status === 404) {
    return false
  }

  const raw = await response.text()

  if (!response.ok) {
    throw new Error(
      `Clerk billing subscription check failed (HTTP ${response.status}): ${raw.slice(0, 300)}`
    )
  }

  const subscription = JSON.parse(raw) as ClerkCommerceSubscription

  return hasActivePlanInSubscription(subscription, planSlug)
}

export function formatUserBillingPortalUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')

  if (trimmed.endsWith('/user/billing')) {
    return trimmed
  }

  if (trimmed.endsWith('/user')) {
    return `${trimmed}/billing`
  }

  return `${trimmed}/user/billing`
}

export function deriveAccountPortalUrlFromFrontendApiUrl(fapiUrl: string): string {
  const url = new URL(fapiUrl)

  if (url.hostname.endsWith('.clerk.accounts.dev')) {
    url.hostname = url.hostname.replace(/\.clerk\.accounts\.dev$/, '.accounts.dev')
  } else if (url.hostname.startsWith('clerk.')) {
    url.hostname = `accounts.${url.hostname.slice('clerk.'.length)}`
  }

  return formatUserBillingPortalUrl(url.origin)
}

export async function resolveClerkBillingPortalUrl(): Promise<string> {
  if (env.clerkAccountPortalUrl) {
    return formatUserBillingPortalUrl(env.clerkAccountPortalUrl)
  }

  if (cachedUserProfileUrl) {
    return formatUserBillingPortalUrl(cachedUserProfileUrl)
  }

  const fapiBaseUrl = resolveClerkFrontendApiUrl()

  try {
    const response = await fetch(`${fapiBaseUrl}/v1/environment`)

    if (response.ok) {
      const data = (await response.json()) as ClerkFapiEnvironment
      const userProfileUrl = data.display_config?.user_profile_url?.trim()

      if (userProfileUrl) {
        cachedUserProfileUrl = userProfileUrl
        return formatUserBillingPortalUrl(userProfileUrl)
      }
    }
  } catch {
    // Fall back to deterministic derivation from the Clerk Frontend API URL.
  }

  return deriveAccountPortalUrlFromFrontendApiUrl(fapiBaseUrl)
}
