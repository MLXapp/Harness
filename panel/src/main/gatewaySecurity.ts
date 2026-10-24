/**
 * Who may use the local API gateway (and, with the same rules, the engine's
 * own ports; see vmlx_engine/browser_security.py). Pure, unit-tested in
 * tests/gateway-security.test.ts.
 *
 *  - Host: only this Mac's own names, so a web page cannot reach the API
 *    through a domain that resolves to 127.0.0.1 (DNS rebinding). When the
 *    gateway is shared on the network, IP addresses and .local names are
 *    allowed too.
 *  - Origin: native apps send none and always pass. Web pages may call the
 *    API only from this Mac (localhost, any port), from desktop app webviews
 *    (app://, tauri://, vscode-webview://, vscode-file://), or from origins the
 *    user added. CORS echoes the allowed origin instead of `*`.
 *  - Other devices (a client that is not this Mac) must send an API key.
 *
 * The same defaults as Ollama's OLLAMA_ORIGINS, plus Rapid-MLX's host check.
 */

import { isIP } from 'net'
import type { OutgoingHttpHeaders } from 'http'

export interface GatewayPolicy {
  /** Address the gateway listens on ("127.0.0.1", "0.0.0.0", "::"). */
  bindHost: string
  /** Extra web origins the user allowed ("*" allows every origin). */
  allowedOrigins: readonly string[]
  /** Extra Host names the user allowed ("*.example.com" matches subdomains). */
  trustedHosts: readonly string[]
}

export interface GatewayRequestFacts {
  host?: string
  origin?: string
  remoteAddress?: string
  /** The client sent a key the gateway accepts (any session's key or the network key). */
  hasValidKey: boolean
}

export type GatewayVerdict =
  | { ok: true; cors: OutgoingHttpHeaders }
  | { ok: false; status: 400 | 401 | 403; code: string; message: string }

const APP_SCHEMES = new Set(['app:', 'tauri:', 'vscode-webview:', 'vscode-file:'])

/** 127.0.0.0/8, ::1 and their IPv4-mapped forms. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const a = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a
  return isIP(v4) === 4 && v4.startsWith('127.')
}

export function isLoopbackBind(bindHost: string): boolean {
  const h = bindHost.toLowerCase()
  return h === 'localhost' || isLoopbackAddress(h)
}

/** The host part of a Host header ("[::1]:8080" → "::1", "localhost:8080" → "localhost"). */
export function hostName(header: string | undefined): string | null {
  if (!header) return null
  const h = header.trim().toLowerCase()
  if (!h || /[\s/@?#]/.test(h)) return null
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    if (end < 0) return null
    const rest = h.slice(end + 1)
    if (rest && !/^:\d{1,5}$/.test(rest)) return null
    return h.slice(1, end)
  }
  const parts = h.split(':')
  if (parts.length > 2) return null
  if (parts.length === 2 && !/^\d{1,5}$/.test(parts[1])) return null
  return parts[0].replace(/\.$/, '') || null
}

function isLoopbackName(name: string): boolean {
  return name === 'localhost' || name.endsWith('.localhost') || isLoopbackAddress(name)
}

function matchesTrusted(name: string, trusted: readonly string[]): boolean {
  return trusted.some(t => {
    const p = t.trim().toLowerCase()
    if (!p) return false
    if (p.startsWith('*.')) return name.endsWith(p.slice(1)) && name.length > p.length - 1
    return name === p
  })
}

export function hostAllowed(header: string | undefined, policy: GatewayPolicy): boolean {
  const name = hostName(header)
  if (!name) return false
  if (isLoopbackName(name) || matchesTrusted(name, policy.trustedHosts)) return true
  // Shared on the network: other devices reach it by IP address or Bonjour name.
  if (!isLoopbackBind(policy.bindHost)) return isIP(name) !== 0 || name.endsWith('.local')
  return false
}

function normalizeOrigin(origin: string): string | null {
  try {
    const u = new URL(origin)
    if (APP_SCHEMES.has(u.protocol)) return `${u.protocol}//${u.host}`
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin.toLowerCase()
  } catch {
    return null
  }
}

export function originAllowed(origin: string | undefined, policy: GatewayPolicy): boolean {
  if (origin === undefined || origin === '') return true // native clients send none
  if (policy.allowedOrigins.some(o => o.trim() === '*')) return true
  if (origin === 'null') return false // sandboxed iframes, file pages, redirects
  let u: URL
  try { u = new URL(origin) } catch { return false }
  if (APP_SCHEMES.has(u.protocol)) return true
  if ((u.protocol === 'http:' || u.protocol === 'https:') && isLoopbackName(u.hostname.replace(/^\[|\]$/g, '').toLowerCase())) return true
  const normalized = normalizeOrigin(origin)
  return !!normalized && policy.allowedOrigins.some(o => normalizeOrigin(o.trim()) === normalized)
}

/** CORS headers for an allowed origin (nothing for native clients). */
export function corsHeaders(origin: string | undefined, preflight = false): OutgoingHttpHeaders {
  if (!origin) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    ...(preflight
      ? {
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Api-Key, Anthropic-Version, Anthropic-Beta',
          'Access-Control-Max-Age': '3600',
        }
      : {}),
  }
}

export function checkGatewayRequest(facts: GatewayRequestFacts, policy: GatewayPolicy, preflight = false): GatewayVerdict {
  if (!hostAllowed(facts.host, policy)) {
    return { ok: false, status: 400, code: 'invalid_host', message: 'Invalid Host header. MLX Harness only answers requests addressed to this Mac.' }
  }
  if (!originAllowed(facts.origin, policy)) {
    return { ok: false, status: 403, code: 'origin_not_allowed', message: 'Web pages from other sites cannot use MLX Harness. Add this origin in Servers & API to allow it.' }
  }
  // A preflight carries no credentials; the request that follows is checked.
  if (!preflight && !isLoopbackAddress(facts.remoteAddress) && !facts.hasValidKey) {
    return { ok: false, status: 401, code: 'api_key_required', message: 'Other devices need the API key shown in MLX Harness → Servers & API.' }
  }
  return { ok: true, cors: corsHeaders(facts.origin, preflight) }
}

/** Comma- or newline-separated list from a setting. */
export function parseList(value: string | null | undefined): string[] {
  return (value ?? '').split(/[,\n]/).map(s => s.trim()).filter(Boolean)
}
