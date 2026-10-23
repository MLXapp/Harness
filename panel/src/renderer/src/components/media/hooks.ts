import { useEffect, useMemo, useState } from 'react'
import type { HardwareInfo } from '../../../../shared/hardware'
import type { MediaKind, MediaProviderId } from '../../../../shared/media/catalog'
import type { MediaJob } from '../../../../shared/media/jobs'
import { useProviders } from '../settings/useProviders'

/** This Mac (chip and memory), read once per page. Null until known. */
export function useMac(): HardwareInfo | null {
  const [mac, setMac] = useState<HardwareInfo | null>(null)
  useEffect(() => {
    let alive = true
    window.api.app.getHardware?.().then(hw => { if (alive) setMac(hw) }).catch(() => undefined)
    return () => { alive = false }
  }, [])
  return mac
}

/** Media accounts with a key saved (WaveSpeed AI, Atlas Cloud). */
export function useMediaAccounts(): ReadonlySet<MediaProviderId> {
  const { providers } = useProviders()
  return useMemo(() => new Set(
    providers.filter(p => p.configured && (p.id === 'wavespeed' || p.id === 'atlascloud')).map(p => p.id as MediaProviderId),
  ), [providers])
}

/** A tab's generations, newest first, kept live by media:job events. */
export function useMediaJobs(kind: MediaKind) {
  const [jobs, setJobs] = useState<MediaJob[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let alive = true
    window.api.media.list(kind).then(list => { if (alive) { setJobs(list); setLoaded(true) } }).catch(() => setLoaded(true))
    const off = window.api.media.onJob(job => {
      if (job.kind !== kind) return
      setJobs(prev => {
        const i = prev.findIndex(j => j.id === job.id)
        if (i < 0) return [job, ...prev]
        const next = prev.slice()
        next[i] = job
        return next
      })
    })
    return () => { alive = false; off() }
  }, [kind])
  const remove = (id: string) => setJobs(prev => prev.filter(j => j.id !== id))
  return { jobs, loaded, remove }
}

/** Seconds since `from`, ticking once a second while `active`. */
export function useElapsed(from: number, active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [active])
  return Math.max(0, Math.round(((active ? now : from) - from) / 1000))
}

export function readStored(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
export function writeStored(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* storage blocked */ }
}
