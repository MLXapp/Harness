/**
 * Direct app tools for small local models. Composio's meta tools (search,
 * then fetch schemas, then execute) are a lot to juggle for a 4–9B model, so
 * a local model gets a short list of real app actions instead
 * ("gmail_send_email", "googlecalendar_events_list" …): at most 12, for the
 * apps the user connected, with schemas fetched once from Composio and
 * cached. Each call still goes through COMPOSIO_MULTI_EXECUTE_TOOL and the
 * same approvals as any app action. Pure.
 */

import type { AppTool } from './appsService'

/** Verified against docs.composio.dev/toolkits/<app> (23 Oct 2026). Reads first. */
export const DIRECT_CATALOG: Readonly<Record<string, readonly string[]>> = {
  gmail: ['GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL', 'GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_REPLY_TO_THREAD'],
  googlecalendar: ['GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_FIND_FREE_SLOTS'],
  slack: ['SLACK_FETCH_CONVERSATION_HISTORY', 'SLACK_SEND_MESSAGE', 'SLACK_FIND_CHANNELS'],
  notion: ['NOTION_SEARCH_NOTION_PAGE', 'NOTION_GET_PAGE_MARKDOWN', 'NOTION_CREATE_NOTION_PAGE'],
  googledrive: ['GOOGLEDRIVE_FIND_FILE', 'GOOGLEDRIVE_DOWNLOAD_FILE', 'GOOGLEDRIVE_CREATE_FILE_FROM_TEXT'],
}

export const DIRECT_MAX_TOOLS = 12

/** Round-robin over the apps so each gets its main read and write first. */
export function pickDirectSlugs(apps: readonly string[], max = DIRECT_MAX_TOOLS): string[] {
  const lists = apps.map(a => [...(DIRECT_CATALOG[a] ?? [])]).filter(l => l.length > 0)
  const out: string[] = []
  for (let i = 0; out.length < max && lists.some(l => l.length > i); i++) {
    for (const l of lists) if (l[i] && out.length < max) out.push(l[i])
  }
  return out
}

export const directName = (slug: string) => slug.toLowerCase()

/** "gmail_send_email" → "GMAIL_SEND_EMAIL" when it is one of the offered tools. */
export function slugForDirect(name: string, offered: readonly AppTool[]): string | null {
  return offered.some(t => t.function.name === name) ? name.toUpperCase() : null
}

export interface DirectSchema { description: string; parameters: Record<string, unknown> }

/** Schemas from a COMPOSIO_GET_TOOL_SCHEMAS result (lenient about field names). */
export function parseToolSchemas(json: unknown): Record<string, DirectSchema> {
  const root = (json ?? {}) as Record<string, any>
  const map = root?.data?.tool_schemas ?? root?.tool_schemas ?? {}
  const out: Record<string, DirectSchema> = {}
  if (!map || typeof map !== 'object') return out
  for (const [slug, def] of Object.entries(map as Record<string, any>)) {
    if (!/^[A-Z0-9_]{3,120}$/.test(slug) || !def || typeof def !== 'object') continue
    const params = def.input_schema ?? def.inputSchema ?? def.input_parameters ?? def.parameters ?? def.schema
    if (!params || typeof params !== 'object') continue
    out[slug] = { description: String(def.description ?? def.human_description ?? slug), parameters: trimSchema(params) }
  }
  return out
}

/** Keep schemas small for small models: shorter descriptions, no examples. */
export function trimSchema(schema: any, depth = 0): any {
  if (!schema || typeof schema !== 'object' || depth > 6) return schema
  if (Array.isArray(schema)) return schema.map(s => trimSchema(s, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'examples' || k === 'example' || k === 'title' || k === 'file_uploadable') continue
    if (k === 'description' && typeof v === 'string') { out[k] = v.length > 240 ? `${v.slice(0, 237)}…` : v; continue }
    out[k] = trimSchema(v, depth + 1)
  }
  return out
}

export function toDirectTools(slugs: readonly string[], schemas: Readonly<Record<string, DirectSchema>>): AppTool[] {
  return slugs
    .filter(s => schemas[s])
    .map(s => ({
      type: 'function' as const,
      function: {
        name: directName(s),
        description: schemas[s].description.length > 400 ? `${schemas[s].description.slice(0, 397)}…` : schemas[s].description,
        parameters: schemas[s].parameters,
      },
    }))
}
