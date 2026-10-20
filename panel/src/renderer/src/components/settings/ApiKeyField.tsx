/**
 * Portions adapted from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License
 * (packages/client/ui-settings-models/src/client/ApiKeyInput.tsx).
 *
 * Write-only API key input. A stored key is never read back into it: when one
 * exists the field starts empty with a "saved" placeholder, and an empty
 * field means "keep it". Show/hide reveals only what is being typed.
 */
import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { apiKeyFieldError, type ApiKeyRejection } from '../../../../shared/providers/apiKey'

const ERROR_KEYS: Record<ApiKeyRejection, string> = {
  empty: 'providers.keyEmpty',
  illegalCharacters: 'providers.keyIllegal',
  envLine: 'providers.keyEnvLine',
  quoted: 'providers.keyQuoted',
}

export function apiKeyErrorText(t: (key: string) => string, draft: string): string | undefined {
  const reason = apiKeyFieldError(draft)
  return reason ? t(ERROR_KEYS[reason]) : undefined
}

export function ApiKeyField({ id, value, onChange, configured, optional, disabled }: {
  id: string
  value: string
  onChange: (value: string) => void
  configured: boolean
  optional?: boolean
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const [revealedValue, setRevealedValue] = useState<string | undefined>()
  const revealed = value.length > 0 && revealedValue === value
  const error = apiKeyErrorText(t, value)
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {optional ? t('providers.apiKeyOptional') : t('providers.apiKey')}
      </label>
      <div className="relative">
        <input
          id={id}
          type={revealed ? 'text' : 'password'}
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          disabled={disabled}
          aria-invalid={!!error}
          aria-describedby={`${id}-help`}
          placeholder={configured ? t('providers.keySavedPlaceholder') : t('providers.keyPlaceholder')}
          onChange={(event) => {
            setRevealedValue(undefined)
            onChange(event.target.value)
          }}
          className={`w-full pl-2.5 pr-9 py-1.5 bg-background border rounded-md text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring transition-colors ${
            error ? 'border-destructive' : 'border-input'
          }`}
        />
        {value.length > 0 && (
          <button
            type="button"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
            aria-label={revealed ? t('providers.keyHide') : t('providers.keyShow')}
            title={revealed ? t('providers.keyHide') : t('providers.keyShow')}
            aria-pressed={revealed}
            disabled={disabled}
            onClick={() => setRevealedValue(revealed ? undefined : value)}
          >
            {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
      <p id={`${id}-help`} className={`text-[11px] ${error ? 'text-destructive' : 'text-muted-foreground'}`}>
        {error ?? t('providers.keyStoredNote')}
      </p>
    </div>
  )
}
