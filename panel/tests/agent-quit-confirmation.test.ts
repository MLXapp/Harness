import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { QuitConfirmation, formatChatNames, resolveQuitPrompt } from '../src/main/agent/quitConfirmation'

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})` : key

describe('quit confirmation copy', () => {
  it('quits silently when nothing is running', () => {
    expect(resolveQuitPrompt({ chats: [], processes: 0 }, t)).toBeUndefined()
  })

  it('names the working chats and the background processes', () => {
    const detail = resolveQuitPrompt({ chats: ['Fix tests', 'Refactor'], processes: 2 }, t)!
    expect(detail).toContain('main.dialog.quitAgentChats(names=“Fix tests”, “Refactor”)')
    expect(detail).toContain('main.dialog.quitAgentProcesses(count=2)')
    expect(detail.endsWith('main.dialog.quitAgentDetail')).toBe(true)
  })

  it('warns rather than quitting silently when inspection failed', () => {
    expect(resolveQuitPrompt('unknown', t)).toBe('main.dialog.quitAgentDetail')
  })

  it('shortens and caps chat names', () => {
    expect(formatChatNames(['a', 'b', 'c', 'd', 'e'])).toBe('“a”, “b”, “c” +2')
    expect(formatChatNames(['  '])).toBe('“New Chat”')
    expect(formatChatNames(['x'.repeat(60)])).toBe(`“${'x'.repeat(39)}…”`)
  })

  it('every locale has the quit strings', () => {
    for (const loc of ['en', 'es', 'ja', 'ko', 'zh']) {
      const d = JSON.parse(readFileSync(`src/renderer/src/i18n/locales/${loc}.json`, 'utf8'))
      for (const k of ['quitAgentTitle', 'quitAgentChats', 'quitAgentProcesses', 'quitAgentDetail', 'quitAgentQuit', 'quitAgentCancel']) {
        expect(typeof d.main.dialog[k], `${loc} ${k}`).toBe('string')
      }
      expect(d.main.dialog.quitAgentChats).toContain('{names}')
      expect(d.main.dialog.quitAgentProcesses).toContain('{count}')
    }
  })
})

describe('QuitConfirmation', () => {
  it('does not open a box when nothing would be interrupted', async () => {
    const show = vi.fn()
    const q = new QuitConfirmation({ inspect: () => ({ chats: [], processes: 0 }), t, show })
    await expect(q.confirm()).resolves.toBe(true)
    expect(show).not.toHaveBeenCalled()
  })

  it('asks, with Quit as button 0 and Cancel as the cancel button', async () => {
    const show = vi.fn().mockResolvedValue({ response: 1, checkboxChecked: false })
    const q = new QuitConfirmation({ inspect: () => ({ chats: ['A'], processes: 0 }), t, show })
    await expect(q.confirm()).resolves.toBe(false)
    expect(show.mock.calls[0][0]).toMatchObject({
      type: 'warning',
      message: 'main.dialog.quitAgentTitle',
      buttons: ['main.dialog.quitAgentQuit', 'main.dialog.quitAgentCancel'],
      cancelId: 1,
    })
    show.mockResolvedValue({ response: 0, checkboxChecked: false })
    await expect(q.confirm()).resolves.toBe(true)
  })

  it('a second Quit while the box is open joins it instead of stacking', async () => {
    let answer!: (v: { response: number; checkboxChecked: boolean }) => void
    const show = vi.fn(() => new Promise<any>(r => { answer = r }))
    const focus = vi.fn()
    const q = new QuitConfirmation({ inspect: () => ({ chats: [], processes: 1 }), t, show, focus })
    const a = q.confirm()
    await Promise.resolve()
    const b = q.confirm()
    expect(focus).toHaveBeenCalled()
    answer({ response: 0, checkboxChecked: false })
    await expect(a).resolves.toBe(true)
    await expect(b).resolves.toBe(true)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('an inspection error still asks', async () => {
    const show = vi.fn().mockResolvedValue({ response: 0, checkboxChecked: false })
    const q = new QuitConfirmation({ inspect: () => { throw new Error('db closed') }, t, show })
    await expect(q.confirm()).resolves.toBe(true)
    expect(show).toHaveBeenCalledTimes(1)
  })
})

describe('quit wiring (source)', () => {
  const index = readFileSync('src/main/index.ts', 'utf8')
  it('asks before quitting, and a signal does not ask', () => {
    const beforeQuit = index.slice(index.indexOf("app.on('before-quit'"))
    expect(beforeQuit.indexOf('quitConfirmation.confirm()')).toBeGreaterThan(-1)
    expect(beforeQuit.indexOf('quitConfirmation.confirm()')).toBeLessThan(beforeQuit.indexOf('isQuitting = true'))
    expect(beforeQuit).toContain('abortAllChatRequests()')
    expect(beforeQuit).toContain('killSpawnedProcesses()')
    expect(index).toMatch(/quitConfirmed = true {2}\/\/ a signal does not ask/)
  })

  it('reopening the window does not stop a running agent turn', () => {
    const appTsx = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(appTsx).toContain('window.api.chat.clearStaleLocks')
  })
})
