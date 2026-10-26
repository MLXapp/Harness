import { describe, expect, it } from 'vitest'


import { isEncryptedSettingKey } from '../src/main/settingsAccess'

describe('which settings are stored encrypted', () => {
  it('covers API keys, the renderer-secret rule and the gateway network key', () => {
    for (const key of ['hf_api_key', 'braveApiKey', 'composio_consumer_api_key', 'gateway_lan_key', 'github_token', 'smtp_password']) {
      expect(isEncryptedSettingKey(key)).toBe(true)
    }
  })
  it('leaves ordinary settings and self-encrypted ones alone', () => {
    for (const key of ['gateway_allowed_origins', 'ui_zoom_factor', 'memory_enabled', 'composio_oauth_secret']) {
      expect(isEncryptedSettingKey(key)).toBe(false)
    }
  })
})
