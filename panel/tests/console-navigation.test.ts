import { describe, expect, it } from 'vitest'
import { consolePageForMode, restoreAppMode } from '../src/renderer/src/lib/consoleNavigation'

describe('Console navigation compatibility', () => {
  it.each([
    ['chat', 'chat'], ['image', 'chat'], ['video', 'chat'], ['audio', 'chat'], ['music', 'chat'], ['code', 'chat'],
    ['server', 'server'], ['api', 'server'], ['tools', 'models'], ['models', 'models'], ['network', 'network'],
  ] as const)('groups existing %s mode under %s', (mode, page) => {
    expect(consolePageForMode(mode)).toBe(page)
  })

  it.each(['chat', 'image', 'video', 'audio', 'music', 'code', 'server', 'api', 'tools', 'models', 'network'] as const)(
    'preserves persisted %s controller', mode => expect(restoreAppMode(mode)).toBe(mode),
  )

  it.each([null, undefined, '', 'unknown', 'studio'])('restores %s safely to chat', mode => {
    expect(restoreAppMode(mode)).toBe('chat')
  })
})
