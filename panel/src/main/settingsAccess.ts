/**
 * Settings the renderer may read back. Secrets (API keys, tokens, passwords)
 * are write-only from the renderer: it can save, delete and ask whether one
 * is set (`settings:has`), but `settings:get` never returns the decrypted
 * value, so a compromised or injected page cannot read them out.
 */
export function isSecretSettingKey(key: unknown): boolean {
  if (typeof key !== 'string') return true
  const k = key.toLowerCase()
  return /api[_-]?key|token|secret|password|passphrase|credential|private[_-]?key/.test(k)
}

export function rendererSettingValue(key: unknown, read: (key: string) => string | undefined): string | null {
  if (isSecretSettingKey(key)) return null
  return read(key as string) ?? null
}

/** Settings whose value is an API key: always stored encrypted. */
export function isApiKeySettingKey(key: string): boolean {
  const k = key.toLowerCase()
  return k.includes('apikey') || k.includes('api_key')
}

/** Settings whose owner stores Keychain ciphertext itself (and decrypts it on read). */
const SELF_ENCRYPTED_SETTING_KEYS: ReadonlySet<string> = new Set(['composio_oauth_secret'])

/**
 * Settings stored encrypted: API keys, anything the renderer treats as a
 * secret (tokens, passwords …, settingsAccess.ts) and the gateway's network key.
 */
export function isEncryptedSettingKey(key: string): boolean {
  if (SELF_ENCRYPTED_SETTING_KEYS.has(key)) return false
  return isApiKeySettingKey(key) || isSecretSettingKey(key) || /lan_key/i.test(key)
}
