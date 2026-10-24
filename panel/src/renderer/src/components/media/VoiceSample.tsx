/**
 * A voice sample for speech in that voice (Audio tab, models with
 * voiceCloning): choose a file or record one, hear it back, confirm the right
 * to use the voice. The sample is made into a mono 24 kHz WAV here (≤ 20 s)
 * and saved by the app under media/voices until it is removed.
 */
import { useEffect, useRef, useState } from 'react'
import { Mic, Square, Upload, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { encodeWav, mixToMono, VOICE_SAMPLE_MAX_S, VOICE_SAMPLE_MIN_S, VOICE_SAMPLE_RATE } from '../../../../shared/media/wav'
import { Waveform } from './Waveform'

export interface VoiceSampleValue { id: string; seconds: number; url: string }

/** Recording stops by itself here (10 s is plenty; the file keeps 20 at most). */
const RECORD_MAX_S = 15

async function toSample(data: ArrayBuffer): Promise<{ wav: Uint8Array<ArrayBuffer>; seconds: number }> {
  // Decoding in a 24 kHz context resamples to the rate the runner wants.
  const ctx = new OfflineAudioContext(1, 1, VOICE_SAMPLE_RATE)
  const audio = await ctx.decodeAudioData(data)
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i))
  const mono = mixToMono(channels, audio.sampleRate)
  return { wav: encodeWav(mono, audio.sampleRate), seconds: mono.length / audio.sampleRate }
}

export function VoiceSamplePanel({ sample, onChange, consent, onConsent }: {
  sample: VoiceSampleValue | null
  onChange: (sample: VoiceSampleValue | null) => void
  consent: boolean
  onConsent: (on: boolean) => void
}) {
  const { t } = useTranslation()
  const [recording, setRecording] = useState<number | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const timerRef = useRef<number | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timerRef.current) window.clearInterval(timerRef.current)
      recorderRef.current?.stream.getTracks().forEach(track => track.stop())
    }
  }, [])

  const accept = async (data: ArrayBuffer) => {
    if (!mounted.current) return
    setWorking(true)
    setError(null)
    try {
      const { wav, seconds } = await toSample(data)
      if (seconds < VOICE_SAMPLE_MIN_S) { setError(t('media.voice.tooShort', { n: VOICE_SAMPLE_MIN_S })); return }
      if (!mounted.current) return
      const saved = await window.api.media.saveVoiceSample(wav)
      if (!saved.ok) { setError(saved.error); return }
      if (!mounted.current) { void window.api.media.deleteVoiceSample(saved.id); return }
      if (sample) void window.api.media.deleteVoiceSample(sample.id)
      if (sample) URL.revokeObjectURL(sample.url)
      onChange({ id: saved.id, seconds, url: URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })) })
    } catch {
      setError(t('media.voice.unreadable'))
    } finally {
      setWorking(false)
    }
  }

  const choose = async (file: File | undefined) => {
    if (!file) return
    if (file.size > 50 * 1024 * 1024) { setError(t('media.voice.unreadable')); return }
    await accept(await file.arrayBuffer())
  }

  const stop = () => recorderRef.current?.state === 'recording' && recorderRef.current.stop()

  const record = async () => {
    setError(null)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    } catch {
      setError(t('media.voice.noMic'))
      return
    }
    const chunks: Blob[] = []
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream)
    } catch {
      stream.getTracks().forEach(track => track.stop())
      setError(t('media.voice.noMic'))
      return
    }
    recorderRef.current = recorder
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
    recorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop())
      if (timerRef.current) window.clearInterval(timerRef.current)
      timerRef.current = null
      if (!mounted.current) return
      setRecording(null)
      void new Blob(chunks).arrayBuffer().then(accept)
    }
    const started = Date.now()
    setRecording(0)
    timerRef.current = window.setInterval(() => {
      const s = (Date.now() - started) / 1000
      setRecording(s)
      if (s >= RECORD_MAX_S) stop()
    }, 200)
    recorder.start()
  }

  const remove = () => {
    if (!sample) return
    void window.api.media.deleteVoiceSample(sample.id)
    URL.revokeObjectURL(sample.url)
    onChange(null)
    onConsent(false)
  }

  return (
    <div className="mx-3 mb-1 rounded-[14px] bg-[rgb(var(--bg-3-rgb)/0.6)] px-3 py-2.5" data-vmlx-section="media-voice-sample">
      {sample ? (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1"><Waveform id={`voice-${sample.id}`} url={sample.url} /></div>
          <span className="shrink-0 text-[12px] text-muted-foreground mlx-num">{t('media.value.seconds', { n: Math.round(sample.seconds) })}</span>
          <button type="button" onClick={remove} aria-label={t('media.voice.remove')} title={t('media.voice.remove')}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-[rgb(var(--foreground)/0.08)] hover:text-foreground"
            data-vmlx-control="media-voice-remove">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {recording === null ? (
            <button type="button" onClick={() => void record()} disabled={working} className="mlx-chip" data-vmlx-control="media-voice-record">
              <Mic className="h-3.5 w-3.5" />{t('media.voice.record')}
            </button>
          ) : (
            <button type="button" onClick={stop} className="mlx-chip is-on" data-vmlx-control="media-voice-stop">
              <Square className="h-3 w-3 fill-current text-destructive" />
              <span className="mlx-num">{t('media.voice.recording', { n: Math.floor(recording) })}</span>
            </button>
          )}
          <button type="button" onClick={() => fileRef.current?.click()} disabled={working || recording !== null} className="mlx-chip" data-vmlx-control="media-voice-file">
            <Upload className="h-3.5 w-3.5" />{t('media.voice.chooseFile')}
          </button>
          <input ref={fileRef} type="file" accept="audio/*" className="hidden"
            onChange={e => { void choose(e.target.files?.[0]); e.target.value = '' }} />
          <span className="px-1 text-[12px] leading-[17px] text-muted-foreground">
            {working ? t('media.voice.preparing') : t('media.voice.hint', { max: VOICE_SAMPLE_MAX_S })}
          </span>
        </div>
      )}
      {error && <p role="alert" className="pt-1.5 text-[12px] text-destructive">{error}</p>}
      <label className="mt-2 flex cursor-pointer items-start gap-2 text-[12.5px] leading-[18px] text-muted-foreground">
        <input type="checkbox" checked={consent} onChange={e => onConsent(e.target.checked)} className="mt-[2px] accent-[rgb(var(--primary))]"
          data-vmlx-control="media-voice-consent" />
        <span>{t('media.voice.consent')}</span>
      </label>
    </div>
  )
}
