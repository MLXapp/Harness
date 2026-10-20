import { useTranslation } from '../../i18n'
import { useVoiceInput, type VoiceInputMode } from './voiceInput'

/**
 * Chat settings → Voice input: Apple Dictation (default) or Whisper on this
 * Mac. Shown only where Apple Dictation exists (macOS); elsewhere the mic
 * always uses Whisper.
 */
export function VoiceInputSetting() {
  const { t } = useTranslation()
  const { mode, appleSupported, setMode } = useVoiceInput()
  if (!appleSupported) return null
  const options: Array<[VoiceInputMode, string]> = [
    ['apple', t('chat.voiceInput.apple')],
    ['whisper', t('chat.voiceInput.whisper')],
  ]
  const index = Math.max(0, options.findIndex(([value]) => value === mode))
  return (
    <div data-vmlx-section="chat-voice-input">
      <h3 className="text-[13px] font-semibold text-foreground mb-2">{t('chat.voiceInput.title')}</h3>
      <div
        role="radiogroup"
        aria-label={t('chat.voiceInput.title')}
        className="relative grid grid-cols-2 w-full rounded-[10px] bg-foreground/[0.05] p-[3px]"
      >
        <div
          aria-hidden
          className="absolute top-[3px] bottom-[3px] left-[3px] rounded-[8px] bg-card ring-1 ring-border/50 shadow-[0_1px_2px_var(--lg-depth),0_4px_12px_-6px_var(--shadow)] transition-transform duration-300 ease-mlx"
          style={{ width: 'calc((100% - 6px) / 2)', transform: `translateX(${index * 100}%)` }}
        />
        {options.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            data-vmlx-control={`voice-input-${value}`}
            onClick={() => setMode(value)}
            className={`relative h-8 truncate px-2 text-[13px] font-medium rounded-[8px] transition-colors ${
              mode === value ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[12px] text-muted-foreground">{t('chat.voiceInput.hint')}</p>
    </div>
  )
}
