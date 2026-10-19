// MLX Node on this Mac, for the Network page and Preferences: status (polled
// while the window is visible), install the copy MLX Studio carries, open it.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MlxAppStatus } from '../../../../shared/mlxNetwork'
import type { MlxNodeInstallError } from '../../../../shared/mlxNode'

export type MlxNodeState = 'checking' | 'installing' | 'running' | 'installed' | 'missing'

export function useMlxNode(pollMs = 5_000) {
  const [status, setStatus] = useState<MlxAppStatus | null>(null)
  const [busy, setBusy] = useState<'installing' | 'opening' | null>(null)
  const [error, setError] = useState<MlxNodeInstallError | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const s = await window.api.network.getMlxAppStatus()
      if (alive.current) setStatus(s)
    } catch { /* keep the last status */ }
  }, [])

  useEffect(() => {
    alive.current = true
    let id: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (document.visibilityState === 'visible') await refresh()
      if (alive.current) id = setTimeout(tick, pollMs)
    }
    tick()
    const vis = () => { if (document.visibilityState === 'visible') { clearTimeout(id); tick() } }
    document.addEventListener('visibilitychange', vis)
    return () => { alive.current = false; clearTimeout(id); document.removeEventListener('visibilitychange', vis) }
  }, [pollMs, refresh])

  const install = useCallback(async () => {
    if (busy) return
    setBusy('installing')
    setError(null)
    try {
      const r = await window.api.network.installMlxNode()
      if (!alive.current) return
      if (!r.ok) setError(r.error)
      await refresh()
      // MLX Node takes a moment to start; look again so "running" shows up.
      setTimeout(() => { void refresh() }, 2_000)
    } catch {
      if (alive.current) setError('failed')
    } finally {
      if (alive.current) setBusy(null)
    }
  }, [busy, refresh])

  const open = useCallback(async () => {
    if (busy) return
    setBusy('opening')
    try { await window.api.network.openMlxApp() } finally {
      setTimeout(() => { if (alive.current) { setBusy(null); void refresh() } }, 800)
    }
  }, [busy, refresh])

  const state: MlxNodeState = busy === 'installing' ? 'installing'
    : status == null ? 'checking'
    : status.running ? 'running'
    : status.installed ? 'installed' : 'missing'

  return { status, state, busy, error, install, open, dismissError: () => setError(null) }
}
