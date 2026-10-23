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
