import { describe, expect, it } from 'vitest'

import { buildContentSecurityPolicy } from '../src/main/csp'

describe('main-process content security policy', () => {
  it('keeps production renderer script execution strict', () => {
    const policy = buildContentSecurityPolicy({ devRenderer: false })

    expect(policy).toContain("script-src 'self';")
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline';")
  })

  it('allows the Vite React dev preamble only for dev renderer sessions', () => {
    const policy = buildContentSecurityPolicy({ devRenderer: true })

    expect(policy).toContain("script-src 'self' 'unsafe-inline';")
    expect(policy).toContain("connect-src 'self' blob: mlx-media: http://127.0.0.1:* http://localhost:*")
    expect(policy).toContain("https://hf-mirror.com https://*.hf-mirror.com")
    expect(policy).toContain("https://modelscope.cn https://*.modelscope.cn")
  })

  it('allows persisted local audio and video without opening remote media', () => {
    const policy = buildContentSecurityPolicy({ devRenderer: false })

    // mlx-media: is MLX Harness's own generated-media folder (main/media/protocol.ts).
    expect(policy).toContain("media-src 'self' data: blob: mlx-media:;")
    expect(policy).not.toMatch(/media-src[^;]*https?:/)
  })

  it('refuses plugins, <base> and form posts; the header also refuses framing', () => {
    const header = buildContentSecurityPolicy({ previewOrigin: 'http://127.0.0.1:5123' })
    for (const d of ["object-src 'none';", "base-uri 'none';", "form-action 'none';", "frame-ancestors 'none';"]) expect(header).toContain(d)
    expect(header).toContain("frame-src 'self' http://127.0.0.1:5123;")
  })

  it('the build-time <meta> copy leaves out frame-ancestors and allows the preview frame on any local port', () => {
    const meta = buildContentSecurityPolicy({ meta: true })
    expect(meta).toContain("script-src 'self';")
    expect(meta).toContain("frame-src 'self' http://127.0.0.1:*;")
    expect(meta).toContain("base-uri 'none';")
    expect(meta).not.toContain('frame-ancestors')
    expect(meta).not.toContain('"')
  })
})
