/**
 * An audio result as a waveform (Audio and Music tabs): play/pause, a playhead
 * that glides with the sound, click or drag to seek, ←/→ by 5 s, Space to play.
 *
 * The peaks come from the file itself (decoded once with Web Audio, cached by
 * URL). Until they arrive the bars sit flat and grow into shape, and if the
 * file can't be decoded the player still works over the flat line. Only one
 * result plays at a time.
 */
import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { useTranslation } from '../../i18n'

const BARS = 88
const peaksCache = new Map<string, number[]>()

async function loadPeaks(url: string): Promise<number[] | null> {
  const hit = peaksCache.get(url)
  if (hit) return hit
  try {
    const data = await (await fetch(url)).arrayBuffer()
    // An offline context decodes without opening an audio device.
    const ctx = new OfflineAudioContext(1, 1, 44100)
    const audio = await ctx.decodeAudioData(data)
    const channels = Array.from({ length: Math.min(2, audio.numberOfChannels) }, (_, i) => audio.getChannelData(i))
    const per = Math.max(1, Math.floor(audio.length / BARS))
    const peaks: number[] = []
    for (let b = 0; b < BARS; b++) {
      let max = 0
      const start = b * per
      const end = Math.min(audio.length, start + per)
      // Every 4th sample is plenty for a bar's height.
      for (const ch of channels) for (let i = start; i < end; i += 4) { const v = Math.abs(ch[i]); if (v > max) max = v }
      peaks.push(max)
    }
    const top = Math.max(...peaks, 1e-6)
    const out = peaks.map(p => Math.max(0.06, Math.sqrt(p / top)))
    peaksCache.set(url, out)
    return out
  } catch {
    return null
  }
}

function clock(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

export function Waveform({ id, url }: { id: string; url: string }) {
  const { t } = useTranslation()
  const audio = useRef<HTMLAudioElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const time = useRef<HTMLSpanElement>(null)
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    let alive = true
    void loadPeaks(url).then(p => { if (alive && p) setPeaks(p) })
    return () => { alive = false }
  }, [url])

  // The playhead follows the audio every frame, without re-rendering.
  useEffect(() => {
    const el = audio.current
    if (!el) return
    let raf = 0
    const draw = () => {
      const d = el.duration || 0
      const p = d > 0 ? el.currentTime / d : 0
      track.current?.style.setProperty('--p', String(p))
      track.current?.setAttribute('aria-valuenow', String(Math.round(el.currentTime)))
      if (time.current) time.current.textContent = `${clock(el.currentTime)} / ${clock(d)}`
      if (!el.paused) raf = requestAnimationFrame(draw)
    }
    const onPlay = () => { setPlaying(true); window.dispatchEvent(new CustomEvent('vmlx:media-play', { detail: { id } })); raf = requestAnimationFrame(draw) }
    const onPause = () => { setPlaying(false); cancelAnimationFrame(raf); draw() }
    const onMeta = () => { setDuration(el.duration || 0); draw() }
    const onOther = (e: Event) => { if ((e as CustomEvent).detail?.id !== id) el.pause() }
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onPause)
    el.addEventListener('seeked', draw)
    el.addEventListener('loadedmetadata', onMeta)
    window.addEventListener('vmlx:media-play', onOther)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onPause)
      el.removeEventListener('seeked', draw)
      el.removeEventListener('loadedmetadata', onMeta)
      window.removeEventListener('vmlx:media-play', onOther)
    }
  }, [id])

  const toggle = () => { const el = audio.current; if (!el) return; if (el.paused) void el.play().catch(() => undefined); else el.pause() }
  const seekTo = (fraction: number) => {
    const el = audio.current
    if (!el || !(el.duration > 0)) return
    el.currentTime = Math.min(el.duration, Math.max(0, fraction * el.duration))
  }
  const fromPointer = (clientX: number) => {
    const r = track.current?.getBoundingClientRect()
    if (r && r.width > 0) seekTo((clientX - r.left) / r.width)
  }
  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    fromPointer(e.clientX)
  }
  const onPointerMove = (e: React.PointerEvent) => { if (e.buttons === 1) fromPointer(e.clientX) }
  const onKey = (e: React.KeyboardEvent) => {
    const el = audio.current
    if (!el) return
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle() }
    else if (e.key === 'ArrowRight') { e.preventDefault(); el.currentTime = Math.min(el.duration || 0, el.currentTime + 5) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); el.currentTime = Math.max(0, el.currentTime - 5) }
  }

  const bars = peaks ?? Array.from({ length: BARS }, () => 0.06)
  // A plain function (not a component), so the bars keep their elements and
  // grow smoothly into shape when the peaks arrive.
  const renderBars = (played: boolean) => (
    <div className={`mlx-wave-bars ${played ? 'is-played' : ''}`} aria-hidden>
      {bars.map((h, i) => <span key={i} style={{ height: `${Math.round(h * 100)}%` }} />)}
    </div>
  )

  return (
    <div className="mlx-wave" data-vmlx-section="media-waveform">
      <audio ref={audio} src={url} preload="metadata" />
      <button type="button" onClick={toggle} className="mlx-wave-play" aria-label={playing ? t('media.pause') : t('media.play')}
        data-vmlx-control="media-play">
        {playing ? <Pause className="h-4 w-4" fill="currentColor" strokeWidth={0} /> : <Play className="ml-0.5 h-4 w-4" fill="currentColor" strokeWidth={0} />}
      </button>
      <div ref={track} className="mlx-wave-track" tabIndex={0} role="slider" aria-label={t('media.position')}
        aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuetext={clock(duration)}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onKeyDown={onKey}>
        {renderBars(false)}
        {renderBars(true)}
      </div>
      <span ref={time} className="mlx-wave-time mlx-num">0:00 / {clock(duration)}</span>
    </div>
  )
}
