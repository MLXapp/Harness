import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { UpdateBannerContent, type UpdateBannerActions } from '../src/renderer/src/components/UpdateBanner'
import type { UpdateState } from '../src/shared/appUpdate'
import en from '../src/renderer/src/i18n/locales/en.json'

function t(key: string, params?: Record<string, string | number>): string {
  let v: any = en
  for (const k of key.split('.')) v = v?.[k]
  if (typeof v !== 'string') throw new Error(`missing key ${key}`)
  return v.replace(/\{(\w+)\}/g, (_: string, k: string) => String(params?.[k] ?? `{${k}}`))
}

const actions = (): UpdateBannerActions => ({ onUpdate: vi.fn(), onLater: vi.fn(), onRestart: vi.fn(), onDownload: vi.fn() })
const base: UpdateState = { phase: 'available', currentVersion: '0.1.0', version: '0.2.0', notes: 'Faster model loading.', blocked: null }
const render = (state: UpdateState, a = actions()) =>
  renderToStaticMarkup(React.createElement(UpdateBannerContent, { state, t, ...a }))
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
const visibleActions = (html: string) => /data-hidden="false"/.test(html)

describe('update banner', () => {
  it('offers the update with notes, Update and Later', () => {
    const html = render(base)
    expect(text(html)).toContain('MLX Studio 0.2.0 is available')
    expect(text(html)).toContain('Faster model loading.')
    expect(html).toContain('data-vmlx-section="release-update"')
    expect(html).toContain('data-vmlx-update-phase="available"')
    expect(html).toContain('data-vmlx-control="release-update-install"')
    expect(html).toContain('data-vmlx-control="release-update-later"')
    expect(text(html)).toMatch(/Later Update$/)
    expect(visibleActions(html)).toBe(true)
  })

  it('offers the download with the reason when this copy cannot update itself', () => {
    const html = render({ ...base, blocked: 'mountedDmg' })
    expect(html).toContain('data-vmlx-control="release-update-download"')
    expect(html).not.toContain('release-update-install')
    expect(text(html)).toContain('Move it to Applications')
  })

  it('shows download progress with a moving bar, and the buttons slide away', () => {
    const html = render({ ...base, phase: 'downloading', received: 247_000_000, total: 588_000_000 })
    expect(text(html)).toContain('Downloading MLX Studio 0.2.0…')
    expect(text(html)).toContain('42%')
    expect(text(html)).toContain('247 MB of 588 MB')
    expect(html).toContain('aria-valuenow="42"')
    expect(html).toContain('transform:scaleX(0.42)')
    expect(visibleActions(html)).toBe(false)
  })

  it('shows verifying with a full bar', () => {
    const html = render({ ...base, phase: 'verifying', received: 588_000_000, total: 588_000_000 })
    expect(text(html)).toContain('Verifying MLX Studio 0.2.0…')
    expect(text(html)).toContain('Checking the download and its signature')
    expect(html).toContain('transform:scaleX(1)')
    expect(html).toContain('mlx-update-fill-busy')
  })

  it('offers Restart to update when ready', () => {
    const a = actions()
    const html = render({ ...base, phase: 'ready' }, a)
    expect(text(html)).toContain('MLX Studio 0.2.0 is ready to install')
    expect(html).toContain('data-vmlx-control="release-update-restart"')
    expect(text(html)).toContain('Restart to update')
  })

  it('explains a failure and offers the manual download, with Try again only where it can help', () => {
    const net = render({ ...base, phase: 'error', error: 'network' })
    expect(text(net)).toContain("MLX Studio 0.2.0 couldn't be installed")
    expect(text(net)).toContain("The download didn't finish.")
    expect(net).toContain('data-vmlx-control="release-update-manual"')
    expect(text(net)).toContain('Download manually')
    expect(net).toContain('data-vmlx-control="release-update-retry"')
    const sig = render({ ...base, phase: 'error', error: 'signature' })
    expect(text(sig)).toContain("isn't signed by MLX Studio's developer")
    expect(sig).not.toContain('release-update-retry')
  })

  it('wires the buttons to the right actions', () => {
    const find = (node: any, control: string): any => {
      if (!node || typeof node !== 'object') return undefined
      if (node.props?.['data-vmlx-control'] === control) return node
      for (const c of React.Children.toArray(node.props?.children)) { const f = find(c, control); if (f) return f }
      return undefined
    }
    const a = actions()
    const tree = (state: UpdateState) => (UpdateBannerContent as any)({ state, t, ...a })
    find(tree(base), 'release-update-install').props.onClick()
    find(tree(base), 'release-update-later').props.onClick()
    find(tree({ ...base, blocked: 'notWritable' }), 'release-update-download').props.onClick()
    find(tree({ ...base, phase: 'ready' }), 'release-update-restart').props.onClick()
    find(tree({ ...base, phase: 'error', error: 'copy' }), 'release-update-manual').props.onClick({ preventDefault() {} })
    expect(a.onUpdate).toHaveBeenCalledOnce()
    expect(a.onLater).toHaveBeenCalledOnce()
    expect(a.onDownload).toHaveBeenCalledTimes(2)
    expect(a.onRestart).toHaveBeenCalledOnce()
  })

  it('every failure and block reason has a message', () => {
    for (const code of Object.keys(en.update.reason)) {
      expect(text(render({ ...base, phase: 'error', error: code as any }))).toContain(t(`update.reason.${code}`).slice(0, 20).replace(/'/g, "'"))
    }
  })

  it('subscribes to the main-process state and animates height instead of popping in', () => {
    const src = readFileSync('src/renderer/src/components/UpdateBanner.tsx', 'utf8')
    expect(src).toContain('window.api.app.onUpdateState')
    expect(src).toContain('window.api.app.getUpdateState')
    expect(src).toContain('ResizeObserver')
    expect(src).not.toContain('localStorage') // Later lives in the main process (per launch)
    const css = readFileSync('src/renderer/src/index.css', 'utf8')
    expect(css).toMatch(/\.mlx-update-reveal \{[^}]*transition: height/)
    expect(css).toMatch(/\.mlx-update-fill \{[^}]*transition: transform/)
    expect(css).toMatch(/\.mlx-update-actions \{[^}]*transition: max-width/)
  })
})
