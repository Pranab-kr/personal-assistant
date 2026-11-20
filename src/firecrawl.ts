import Firecrawl, {
  type DiscoveredTool,
  type Document,
  type SearchData,
  type SearchResultWeb
} from "@mendable/firecrawl-js"
import { tool } from "ai"
import { z } from "zod"
import { env } from "./env.js"

if (!env.firecrawlApiKey) {
  console.warn("[firecrawl] FIRECRAWL_API_KEY is not set; live-data lookups will fail.")
}

const client = new Firecrawl({ apiKey: env.firecrawlApiKey })

const MAX_RESULT_CHARS = 24_000
const MAX_PAGE_CHARS = 20_000

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }

  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} characters]`
}

function capResult(value: unknown): unknown {
  const json = JSON.stringify(value)

  return json.length <= MAX_RESULT_CHARS ? value : truncate(json, MAX_RESULT_CHARS)
}

function errorResult(error: unknown) {
  console.error("[firecrawl] tool error", error instanceof Error ? error.message : String(error))

  return {
    ok: false,
    error: "The live-data lookup failed. Try a different query or scrape a specific page."
  }
}

function isScrapedDocument(result: Document | SearchResultWeb): result is Document {
  return "metadata" in result
}

function summarizeWebResults(data: SearchData) {
  return (data.web ?? []).slice(0, 8).map((result) => {
    if (isScrapedDocument(result)) {
      return {
        url: result.metadata?.sourceURL ?? result.metadata?.url,
        title: result.metadata?.title,
        description: result.metadata?.description
      }
    }

    return {
      url: result.url,
      title: result.title,
      description: result.description
    }
  })
}

function summarizeDataTool(entry: DiscoveredTool) {
  return {
    provider: entry.provider,
    capability: entry.capability,
    name: entry.name,
    description: entry.description,
    whenToUse: entry.whenToUse,
    creditsCost: entry.creditsCost,
    perRecord: entry.perRecord,
    options: entry.options,
    requiresOneOf: entry.requiresOneOf,
    response: entry.response,
    exampleRequest: entry.example?.request
  }
}

function summarizeDocument(document: Document, requestedUrl: string) {
  return {
    ok: true,
    url: document.metadata?.sourceURL ?? requestedUrl,
    title: document.metadata?.title,
    description: document.metadata?.description,
    publishedTime: document.metadata?.publishedTime,
    markdown: truncate(document.markdown ?? "", MAX_PAGE_CHARS)
  }
}

export const firecrawlTools = {
  web_search: tool({
    description:
      "Search the live web and discover structured data providers. Use this first for any request that depends on current information: prices, deals, availability, tickets, reservations, listings, local businesses, reviews, news, sports, travel, shopping, jobs, company or financial data, or anything that changes over time. Returns web results plus matching provider contracts that can be executed with execute_data_tool.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "The user's actual request as a natural-language search query. Preserve locations, dates, brand names, product names, and constraints."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(6)
        .describe("How many web results to return. Defaults to 6.")
    }),
    execute: async ({ query, limit }) => {
      try {
        const data = await client.search(query, {
          sources: ["web", "alexandria"],
          limit,
          toolDetail: "full",
          domainTools: true
        })

        return capResult({
          ok: true,
          query,
          web: summarizeWebResults(data),
          dataTools: (data.tools ?? []).slice(0, 6).map(summarizeDataTool),
          note:
            "dataTools are discovery contracts, not results. To use one, call execute_data_tool with its provider and capability and supply the options it lists."
        })
      } catch (error) {
        return errorResult(error)
      }
    }
  }),

  execute_data_tool: tool({
    description:
      "Execute a structured live-data provider returned by web_search. Use the provider, capability, and option names exactly as they appear in the returned contract. Do not invent provider names, capabilities, or fields. Returns live records such as prices, availability, listings, restaurant slots, reviews, or financial data.",
    inputSchema: z.object({
      provider: z
        .string()
        .describe("Provider id from a web_search dataTools contract, for example 'resy'."),
      capability: z
        .string()
        .describe(
          "Capability id from the same web_search contract, for example 'availability'."
        ),
      options: z
        .record(z.string(), z.unknown())
        .default({})
        .describe(
          "Input object matching the contract's options. Use the exact option names and required fields shown in the contract."
        )
    }),
    execute: async ({ provider, capability, options }) => {
      try {
        const data = await client.scrape({
          alexandria: {
            provider,
            capability,
            options
          }
        })

        const results = data.alexandria.map((entry) => {
          if (entry.error) {
            console.error(
              "[firecrawl] provider error",
              entry.error.code,
              entry.error.message
            )

            return {
              provider: entry.provider,
              capability: entry.capability,
              failed: true
            }
          }

          return {
            provider: entry.provider,
            capability: entry.capability,
            creditsCost: entry.creditsCost,
            records: entry.records,
            data: entry.data
          }
        })

        return capResult({
          ok: results.every((entry) => !("failed" in entry)),
          creditsCost: data.creditsCost,
          results
        })
      } catch (error) {
        return errorResult(error)
      }
    }
  }),

  scrape_url: tool({
    description:
      "Read the full content of one specific web page as clean markdown. Use this for a URL the user shared, or for the most promising result from web_search when the snippet is not enough. Do not use it to search.",
    inputSchema: z.object({
      url: z.string().url().describe("The absolute URL to read."),
      onlyMainContent: z
        .boolean()
        .default(true)
        .describe("Strip navigation, footers, and other boilerplate. Defaults to true.")
    }),
    execute: async ({ url, onlyMainContent }) => {
      try {
        const document = await client.scrape(url, {
          formats: ["markdown"],
          onlyMainContent,
          maxAge: 0
        })

        return summarizeDocument(document, url)
      } catch (error) {
        return errorResult(error)
      }
    }
  }),

  get_current_datetime: tool({
    description:
      "Get the current date and time. Use this before handling relative dates such as 'today', 'tonight', 'tomorrow', or 'this weekend' so live-data queries use the correct dates.",
    inputSchema: z.object({}),
    execute: async () => {
      const now = new Date()

      return {
        iso: now.toISOString(),
        formatted: now.toString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        note: "This is the server timezone. If the user's timezone is unclear and matters for the answer, ask for it."
      }
    }
  })
}
