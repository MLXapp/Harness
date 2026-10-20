import { useCallback, useEffect, useState } from 'react'

/**
 * How the composer's mic works: Apple Dictation (macOS system dictation, the
 * default) or recording and transcribing with a Whisper model on the engine.
 * Stored in app settings under `voiceInput`.
 */
export type VoiceInputMode = 'apple' | 'whisper'

export const VOICE_INPUT_KEY = 'voiceInput'
const CHANGED_EVENT = 'vmlx:voice-input-changed'

/** Apple Dictation exists only on macOS; everything else uses Whisper. */
export function resolveVoiceInput(saved: string | null | undefined, appleSupported: boolean): VoiceInputMode {
  if (!appleSupported) return 'whisper'
  return saved === 'whisper' ? 'whisper' : 'apple'
}

export function appleDictationSupported(): boolean {
  try {
    return window.api?.dictation?.supported() === true
  } catch {
    return false
  }
}

export function useVoiceInput(): { mode: VoiceInputMode; appleSupported: boolean; setMode: (mode: VoiceInputMode) => void } {
  const appleSupported = appleDictationSupported()
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.api?.settings?.get(VOICE_INPUT_KEY)
      .then(value => { if (alive) setSaved(value) })
      .catch(() => undefined)
    const onChange = (event: Event) => setSaved((event as CustomEvent<string>).detail)
    window.addEventListener(CHANGED_EVENT, onChange)
    return () => {
      alive = false
      window.removeEventListener(CHANGED_EVENT, onChange)
    }
  }, [])

  const setMode = useCallback((mode: VoiceInputMode) => {
    setSaved(mode)
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: mode }))
    void window.api?.settings?.set(VOICE_INPUT_KEY, mode)
  }, [])

  return { mode: resolveVoiceInput(saved, appleSupported), appleSupported, setMode }
}
