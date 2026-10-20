import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyCheckRequest, KeyCheckResult } from '../../../../shared/providers/keyCheck'

export type KeyCheckState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'done'; result: KeyCheckResult }

/**
 * Live key check: 400ms after the last edit (or paste) the request goes to
 * the main process; a newer edit makes an older answer irrelevant.
 * `enabled` false keeps it idle (e.g. an empty field or an invalid URL).
 */
export function useKeyCheck(request: KeyCheckRequest, enabled: boolean, delayMs = 400) {
  const [state, setState] = useState<KeyCheckState>({ phase: 'idle' })
  const seq = useRef(0)
  const key = JSON.stringify(request)

  const run = useCallback(async (req: KeyCheckRequest) => {
    const mine = ++seq.current
    setState({ phase: 'checking' })
    let result: KeyCheckResult
    try {
      result = await window.api.providers.checkKey(req)
    } catch {
      result = { ok: false, reason: 'network', message: 'Could not reach the service' }
    }
    if (seq.current === mine) setState({ phase: 'done', result })
  }, [])

  useEffect(() => {
    seq.current++
    if (!enabled) {
      setState({ phase: 'idle' })
      return
    }
    // Say "Checking…" at once so the status never lags the typing.
    setState({ phase: 'checking' })
    const req = JSON.parse(key) as KeyCheckRequest
    const timer = window.setTimeout(() => void run(req), delayMs)
    return () => window.clearTimeout(timer)
  }, [key, enabled, delayMs, run])

  const retry = useCallback(() => void run(JSON.parse(key) as KeyCheckRequest), [key, run])
  return { state, retry }
}
