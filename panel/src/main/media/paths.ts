/**
 * Pure helpers for mlx-media:// URLs (no Electron import, so the runner and
 * tests can use them anywhere). The protocol handler is in ./protocol.ts.
 */

import { join } from 'path'

export const MEDIA_SCHEME = 'mlx-media'
const KINDS = new Set(['image', 'video', 'audio', 'music'])
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4',
  json: 'application/json',
}

export function mimeFor(name: string): string {
  return MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

export function mediaUrl(kind: string, file: string): string {
  return `${MEDIA_SCHEME}://media/${kind}/${encodeURIComponent(file)}`
}

/** Pure: the file a mlx-media URL points to, or null when it points anywhere else. */
export function resolveMediaPath(mediaRoot: string, rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${MEDIA_SCHEME}:` || url.host !== 'media') return null
  const parts = url.pathname.split('/').filter(Boolean).map(p => {
    try { return decodeURIComponent(p) } catch { return '' }
  })
  if (parts.length !== 2) return null
  const [kind, file] = parts
  if (!KINDS.has(kind) || !FILE.test(file) || file.includes('..')) return null
  return join(mediaRoot, kind, file)
}
