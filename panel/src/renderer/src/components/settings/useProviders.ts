import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderView } from '../../../../shared/providers/types'

/**
 * Providers for Preferences → Models and the chat model picker: stored
 * providers (redacted: `configured` only) and the local servers found by the
 * last probe. Refreshes when the main process reports a change.
 */
export function useProviders(options: { probe?: boolean } = {}) {
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [localServers, setLocalServers] = useState<ProviderView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [probing, setProbing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  const reload = useCallback(async () => {
    const api = window.api?.providers
    if (!api) return
    try {
      const result = await api.list()
      if (!mounted.current) return
      if (result.ok) {
        setProviders(result.providers)
        setLocalServers(result.localServers)
        setError(null)
      } else {
        setError(result.error)
      }
    } catch (err) {
      if (mounted.current) setError(String(err))
    } finally {
      if (mounted.current) setLoaded(true)
    }
  }, [])

  const probe = useCallback(async () => {
    const api = window.api?.providers
    if (!api) return
    setProbing(true)
    try {
      const result = await api.probeLocal()
      if (mounted.current && result.ok) setLocalServers(result.localServers)
    } catch {
      // A failed probe just means no local servers.
    } finally {
      if (mounted.current) setProbing(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void reload()
    if (options.probe) void probe()
    const unsubscribe = window.api?.providers?.onChanged(() => { void reload() })
    return () => {
      mounted.current = false
      unsubscribe?.()
    }
  }, [reload, probe, options.probe])

  return { providers, localServers, loaded, probing, error, reload, probe }
}
