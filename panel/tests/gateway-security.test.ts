import { describe, expect, it } from 'vitest'
import { checkGatewayRequest, hostAllowed, hostName, isLoopbackAddress, originAllowed, type GatewayPolicy } from '../src/main/gatewaySecurity'

const local: GatewayPolicy = { bindHost: '127.0.0.1', allowedOrigins: [], trustedHosts: [] }
const lan: GatewayPolicy = { bindHost: '0.0.0.0', allowedOrigins: [], trustedHosts: [] }

describe('gateway: Host header (DNS rebinding)', () => {
  it("answers only this Mac's names when local", () => {
    for (const h of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080', 'LOCALHOST', 'app.localhost:8080', '127.0.0.2']) expect(hostAllowed(h, local), h).toBe(true)
    for (const h of ['evil.example:8080', '192.168.1.5:8080', 'localhost.evil.com', '127.0.0.1.nip.io:8080', '', undefined, 'localhost:80:90', 'a b', 'user@localhost'])
      expect(hostAllowed(h as string | undefined, local), String(h)).toBe(false)
  })
  it('on the network also takes IP addresses and .local names, never other DNS names', () => {
    for (const h of ['192.168.1.24:8080', '[fe80::1]:8080', 'alexs-mac.local:8080']) expect(hostAllowed(h, lan), h).toBe(true)
    expect(hostAllowed('evil.example:8080', lan)).toBe(false)
    expect(hostAllowed('gpu.example.com', { ...lan, trustedHosts: ['*.example.com'] })).toBe(true)
  })
  it('parses ports and IPv6 brackets', () => {
    expect(hostName('[::1]:8080')).toBe('::1')
    expect(hostName('localhost.:8080')).toBe('localhost')
    expect(hostName('[::1]x')).toBeNull()
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('10.0.0.1')).toBe(false)
  })
})

describe('gateway: web pages (Origin)', () => {
  it('lets native apps and pages on this Mac in, keeps other sites out', () => {
    expect(originAllowed(undefined, local)).toBe(true)
    for (const o of ['http://localhost:3000', 'https://127.0.0.1:5173', 'http://[::1]:8000', 'vscode-webview://abc123', 'app://obsidian.md', 'tauri://localhost'])
      expect(originAllowed(o, local), o).toBe(true)
    for (const o of ['https://evil.example', 'null', 'http://localhost.evil.com', 'chrome-extension://abcdef', 'file://'])
      expect(originAllowed(o, local), o).toBe(false)
  })
  it('allows origins the user listed, or every origin with "*"', () => {
    const p = { ...local, allowedOrigins: ['https://chat.example.com', 'chrome-extension://abcdef'] }
    expect(originAllowed('https://CHAT.example.com', p)).toBe(true)
    expect(originAllowed('https://chat.example.com:444', p)).toBe(false)
    expect(originAllowed('https://anything.test', { ...local, allowedOrigins: ['*'] })).toBe(true)
  })
})

describe('gateway: verdicts', () => {
  const base = { host: 'localhost:8080', remoteAddress: '127.0.0.1', hasValidKey: false }
  it('echoes the allowed origin instead of "*"', () => {
    const v = checkGatewayRequest({ ...base, origin: 'http://localhost:3000' }, local)
    expect(v).toEqual({ ok: true, cors: { 'Access-Control-Allow-Origin': 'http://localhost:3000', Vary: 'Origin' } })
    const native = checkGatewayRequest(base, local)
    expect(native).toEqual({ ok: true, cors: {} })
  })
  it('refuses a rebinding name, a foreign page, and another device without a key', () => {
    expect(checkGatewayRequest({ ...base, host: 'attacker.test:8080' }, local)).toMatchObject({ ok: false, status: 400 })
    expect(checkGatewayRequest({ ...base, origin: 'https://evil.example' }, local)).toMatchObject({ ok: false, status: 403 })
    const device = { host: '192.168.1.24:8080', remoteAddress: '192.168.1.40', hasValidKey: false }
    expect(checkGatewayRequest(device, lan)).toMatchObject({ ok: false, status: 401, code: 'api_key_required' })
    expect(checkGatewayRequest({ ...device, hasValidKey: true }, lan)).toMatchObject({ ok: true })
    // A preflight carries no key; the real request that follows is checked.
    expect(checkGatewayRequest({ ...device, origin: 'http://localhost:3000' }, lan, true)).toMatchObject({ ok: true })
  })
})
