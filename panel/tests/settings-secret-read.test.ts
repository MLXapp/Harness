import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { isSecretSettingKey, rendererSettingValue } from '../src/main/settingsAccess'

describe('settings:get never hands secrets to the renderer', () => {
  it('treats keys, tokens and passwords as secret', () => {
    for (const k of ['braveApiKey', 'hf_api_key', 'openai-api-key', 'githubToken', 'client_secret', 'password', 'privateKey']) {
      expect(isSecretSettingKey(k)).toBe(true)
    }
    for (const k of ['appMode', 'hf_endpoint', 'mlxWalletName', 'ttsVoice', 'lastActiveChatId']) {
      expect(isSecretSettingKey(k)).toBe(false)
    }
  })

  it('returns null for a secret even when it is set', () => {
    const read = (k: string) => (k === 'braveApiKey' ? 'BSA-real' : 'plain')
    expect(rendererSettingValue('braveApiKey', read)).toBeNull()
    expect(rendererSettingValue('appMode', read)).toBe('plain')
    expect(rendererSettingValue(42, read)).toBeNull()
  })

  it('is wired into the IPC handler', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    expect(main).toContain("ipcMain.handle('settings:get', (_e, key: string) => rendererSettingValue(key, k => db.getSetting(k)))")
  })
})
