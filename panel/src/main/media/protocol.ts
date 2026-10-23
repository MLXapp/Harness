/**
 * mlx-media:// serves generated images, videos and audio from MLX Harness's
 * own media folder (userData/media/<kind>/<file>) to the renderer, with Range
 * support so <video> and <audio> can seek. Nothing outside that folder is
 * reachable: the path must be exactly <kind>/<file> with a plain file name.
 */

import { protocol } from 'electron'
import { createReadStream, statSync } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'

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

/** Call before app ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  ])
}

/** Call after app ready. */
export function handleMediaProtocol(mediaRoot: () => string): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    const path = resolveMediaPath(mediaRoot(), request.url)
    if (!path) return new Response('Not found', { status: 404 })
    let size: number
    try {
      const stat = statSync(path)
      if (!stat.isFile()) return new Response('Not found', { status: 404 })
      size = stat.size
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const type = mimeFor(path)
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
    if (range && size > 0) {
      let start = range[1] ? Number(range[1]) : NaN
      let end = range[2] ? Number(range[2]) : size - 1
      if (Number.isNaN(start)) { start = Math.max(0, size - end); end = size - 1 }
      end = Math.min(end, size - 1)
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
        },
      })
    }
    const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
    })
  })
}
