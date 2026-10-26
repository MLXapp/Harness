/**
 * The local ports this app serves on (gateway, engines, workspace preview),
 * for the Workspace sandbox to refuse: a confined command must not reach the
 * app's own services. Sources register here so the chat code needs no
 * import of the services themselves.
 */

const sources = new Set<() => Array<number | null | undefined>>()

export function registerAppPortSource(source: () => Array<number | null | undefined>): void {
  sources.add(source)
}

export function appLocalPorts(): number[] {
  const out = new Set<number>()
  for (const source of sources) {
    try {
      for (const p of source()) if (typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536) out.add(p)
    } catch { /* a source that fails adds nothing */ }
  }
  return [...out]
}
