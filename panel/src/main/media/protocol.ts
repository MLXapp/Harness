/**
 * mlx-media:// serves generated images, videos and audio from MLX Harness's
 * own media folder (userData/media/<kind>/<file>) to the renderer, with Range
 * support so <video> and <audio> can seek. Nothing outside that folder is
 * reachable: the path must be exactly <kind>/<file> with a plain file name.
 */

import { protocol } from 'electron'
import { createReadStream, statSync } from 'fs'
import { Readable } from 'stream'
import { MEDIA_SCHEME, mimeFor, resolveMediaPath } from './paths'

export { MEDIA_SCHEME, mediaUrl, mimeFor, resolveMediaPath } from './paths'

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
