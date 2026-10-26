/**
 * Name resolution check shared by the agent browser and fetch_url: does a
 * host name point at a loopback, private or link-local address? No Electron
 * here, so the executor and tests can use it.
 */

import { lookup } from 'dns/promises'
import { isPrivateHost } from './agentBrowser'

/** host → { private?, until } for 60 s, so a page's many requests resolve once. */
const dnsCache = new Map<string, { bad: boolean; until: number }>()
const isIpLiteral = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')

/** True when a host name resolves to any private, loopback or link-local address. */
export async function resolvesPrivate(hostname: string): Promise<boolean> {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!h || isIpLiteral(h)) return false // literals are judged by isPrivateHost
  const hit = dnsCache.get(h)
  if (hit && hit.until > Date.now()) return hit.bad
  let bad = false
  try {
    const all = await lookup(h, { all: true, verbatim: true })
    bad = all.some(a => isPrivateHost(a.address))
  } catch {
    bad = false // unresolvable: Chromium fails the request by itself
  }
  if (dnsCache.size > 500) dnsCache.clear()
  dnsCache.set(h, { bad, until: Date.now() + 60_000 })
  return bad
}

