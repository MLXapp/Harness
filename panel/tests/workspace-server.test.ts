import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OFFLINE_GUARD, ONLINE_MARKER, PREVIEW_CSP, PREVIEW_CSP_ONLINE, isPreviewUrl, resolveUnder, startPreviewServer, stopPreviewServer } from '../src/main/workspace/previewServer'
import { buildContentSecurityPolicy } from '../src/main/csp'

const root = mkdtempSync(join(tmpdir(), 'mlx-ws-'))
afterAll(() => { stopPreviewServer(); rmSync(root, { recursive: true, force: true }) })

function get(port: number, path: string, host = `127.0.0.1:${port}`): Promise<{ status: number; csp?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, csp: res.headers['content-security-policy'] as string | undefined, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('workspace preview server', () => {
  it('serves a reply\'s files offline by default, online when allowed, nothing else', async () => {
    mkdirSync(join(root, 'chat1', 'm1'), { recursive: true })
    writeFileSync(join(root, 'chat1', 'm1', 'index.html'), '<h1>hi</h1>')
    mkdirSync(join(root, 'chat1', 'm2'), { recursive: true })
    writeFileSync(join(root, 'chat1', 'm2', 'index.html'), '<h1>web</h1>')
    writeFileSync(join(root, 'chat1', 'm2', ONLINE_MARKER), '1')
    writeFileSync(join(root, 'secret.txt'), 'no')
    const port = await startPreviewServer(root)
    expect(isPreviewUrl(`http://127.0.0.1:${port}/chat1/m1/index.html`)).toBe(true)
    expect(isPreviewUrl(`http://127.0.0.1:${port + 1}/x`)).toBe(false)

    writeFileSync(join(root, 'chat1', 'm1', 'doc.html'), '<!DOCTYPE html><h1>d</h1>')
    const page = await get(port, '/chat1/m1/index.html?v=3')
    expect(page).toMatchObject({ status: 200, body: OFFLINE_GUARD + '<h1>hi</h1>', csp: PREVIEW_CSP })
    expect((await get(port, '/chat1/m1/doc.html')).body).toBe('<!DOCTYPE html>' + OFFLINE_GUARD + '<h1>d</h1>')
    expect((await get(port, '/chat1/m2/index.html')).body).toBe('<h1>web</h1>')
    expect(PREVIEW_CSP).toContain("connect-src 'self'")
    expect(PREVIEW_CSP).toContain("img-src 'self' data: blob:")
    expect((await get(port, '/chat1/m2/index.html')).csp).toBe(PREVIEW_CSP_ONLINE)
    expect((await get(port, '/chat1/m2/.online')).status).toBe(404)
    expect((await get(port, '/secret.txt')).status).toBe(404)
    expect((await get(port, '/chat1/m1/../../secret.txt')).status).toBe(404)
    expect((await get(port, '/chat1/m1/index.html', 'evil.example:80')).status).toBe(400)
    expect(resolveUnder(root, '/a/b/%2e%2e/x')).toBeNull()
  })

  it('the window frames only the preview server', () => {
    const csp = buildContentSecurityPolicy({ previewOrigin: 'http://127.0.0.1:41234' })
    expect(csp).toContain("frame-src 'self' http://127.0.0.1:41234;")
    expect(buildContentSecurityPolicy({})).toContain("frame-src 'self';")
    expect(buildContentSecurityPolicy({ previewOrigin: 'http://evil.example' })).toContain("frame-src 'self';")
  })
})
