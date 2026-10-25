/**
 * The workspace's preview server: serves the files a reply made (a website,
 * a component page) from MLX Harness's own folder on 127.0.0.1, so the side
 * panel can show them as a real page (own origin, own scripts) and "Open in
 * browser" can hand the same address to Safari or Chrome.
 *
 * Only this Mac (127.0.0.1, Host checked), only files under the workspace
 * folder, no directory listings. Pure parts (paths, types, headers) are
 * exported for tests.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { createReadStream, existsSync, statSync } from 'fs'
import { extname, join, relative, resolve, sep } from 'path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.jsx': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8', '.ts': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff',
}

export function contentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? 'text/plain; charset=utf-8'
}

/**
 * A reply's page is model-written, so by default it runs offline: its own
 * scripts and styles, plus the pinned CDNs a generated page usually loads
 * (React, Babel, Tailwind, Google Fonts) — nothing it could send data to.
 * Navigation and new windows are stopped by the frame's sandbox and the
 * window's frame-src (this exact origin only).
 */
export const PREVIEW_CSP =
  "default-src 'self';" +
  " script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.tailwindcss.com https://cdn.jsdelivr.net;" +
  " style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com https://cdn.jsdelivr.net;" +
  " font-src 'self' data: https://fonts.gstatic.com;" +
  " img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self';" +
  " form-action 'self'; object-src 'none'; base-uri 'self'"

/** After the user allows it ("Allow internet"): images, data and fetches from the web. */
export const PREVIEW_CSP_ONLINE =
  "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval';" +
  " connect-src 'self' https: wss: data: blob:;" +
  " img-src 'self' https: data: blob:;" +
  " media-src 'self' https: data: blob:;" +
  " form-action 'self'; object-src 'none'; base-uri 'self'"

/** Marker file in a reply's folder: the user allowed its page the internet (never served: a dotfile). */
export const ONLINE_MARKER = '.online'

/** The file a request path names under root, or null (escapes, hidden files). */
export function resolveUnder(root: string, urlPath: string): string | null {
  let decoded: string
  try { decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]) } catch { return null }
  const parts = decoded.split('/').filter(Boolean)
  if (parts.length < 3 || parts.some(p => p === '..' || p.startsWith('.') || p.includes('\\') || p.includes('\0'))) return null
  const full = resolve(root, ...parts)
  return full.startsWith(resolve(root) + sep) ? full : null
}

let server: Server | null = null
let port = 0
let rootDir = ''
let starting: Promise<number> | null = null

export function previewOrigin(): string | null {
  return port ? `http://127.0.0.1:${port}` : null
}

/** Whether a URL is one of this server's pages (its own CSP applies). */
export function isPreviewUrl(url: string): boolean {
  const origin = previewOrigin()
  return !!origin && (url === origin || url.startsWith(`${origin}/`))
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  try {
    const host = (req.headers.host ?? '').toLowerCase()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { res.writeHead(400).end(); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return }
    const file = resolveUnder(rootDir, req.url ?? '/')
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
      return
    }
    const [chat, message] = relative(resolve(rootDir), file).split(sep)
    const online = existsSync(join(rootDir, chat, message, ONLINE_MARKER))
    res.writeHead(200, {
      'Content-Type': contentType(file),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': online ? PREVIEW_CSP_ONLINE : PREVIEW_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
    })
    if (req.method === 'HEAD') { res.end(); return }
    // A file replaced while it is read (a newer version published) just ends the reply.
    const stream = createReadStream(file)
    stream.on('error', () => { try { res.destroy() } catch { /* closed */ } })
    stream.pipe(res)
  } catch {
    try { if (!res.headersSent) res.writeHead(500); res.end() } catch { /* closed */ }
  }
}

/** Start (once) and return the port. */
export function startPreviewServer(root: string): Promise<number> {
  rootDir = root
  if (server && port) return Promise.resolve(port)
  if (starting) return starting
  starting = new Promise<number>((resolveStart, reject) => {
    const s = createServer(handle)
    s.on('error', err => { starting = null; reject(err) })
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      port = typeof addr === 'object' && addr ? addr.port : 0
      server = s
      resolveStart(port)
    })
  })
  return starting
}

export function stopPreviewServer(): void {
  try { server?.close() } catch { /* closed */ }
  server = null
  port = 0
  starting = null
}

