/**
 * The workspace: what a reply made (a website, a React component, an SVG,
 * scripts and documents), beside the chat like Claude's and ChatGPT's
 * artifacts. Preview shows the page live from MLX Harness's own preview
 * server on 127.0.0.1; Code shows each file; Download saves the files; Open
 * in browser gives the same address to the browser.
 *
 * It opens by itself when a reply starts writing a page, follows the code
 * while it is written, and switches to the preview when the reply is done.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Code2, Copy, Download, ExternalLink, FileCode2, Globe, Image as ImageIcon, RotateCw, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Btn, Spinner } from '../accounts/ui'
import { extractArtifacts, hasPreview, previewFiles, type ArtifactSet } from '../../../../shared/artifacts'
import { escapeCodeHtml, highlightCodeBlock } from '../chat/MessageBubble'

const WIDTH_KEY = 'mlx.workspace.width'
const MIN_W = 360

function readWidth(): number {
  try { const n = Number(localStorage.getItem(WIDTH_KEY)); return Number.isFinite(n) && n >= MIN_W ? n : 620 } catch { return 620 }
}

export function WorkspacePanel({ chatId, open, messageId, content, streaming, initialPath, onClose }: {
  chatId: string
  /** Shown (the panel keeps the last reply while it slides closed). */
  open: boolean
  messageId: string | null
  content: string
  streaming: boolean
  initialPath?: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  // While a reply streams, parse and draw at most every 150 ms (not per token).
  const shownContent = useThrottled(content, streaming ? 150 : 0)
  const set = useMemo<ArtifactSet>(() => extractArtifacts(shownContent), [shownContent])
  const previewable = hasPreview(set)
  const [tab, setTab] = useState<'preview' | 'code'>('preview')
  const [path, setPath] = useState<string | undefined>(initialPath)
  const [url, setUrl] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [frameReady, setFrameReady] = useState(false)
  const [reload, setReload] = useState(0)
  const [copied, setCopied] = useState(false)
  const [width, setWidth] = useState(readWidth)
  const [dragging, setDragging] = useState(false)
  // A reply's page runs offline until the user allows it the internet.
  const [online, setOnline] = useState(false)
  const published = useRef<string>('')
  const version = useRef(0)
  // The frame (and whatever the page runs) goes away once the panel has closed.
  const [frameAlive, setFrameAlive] = useState(open)
  useEffect(() => {
    if (open) { setFrameAlive(alive => { if (!alive) setFrameReady(false); return true }); return }
    const id = window.setTimeout(() => setFrameAlive(false), 420)
    return () => window.clearTimeout(id)
  }, [open])

  // A new reply in the panel starts on its page (or the file asked for).
  useEffect(() => {
    setPath(initialPath)
    setUrl(null)
    setError(null)
    setOnline(false)
    published.current = ''
  }, [messageId, initialPath])

  // While a reply writes, show the code being written; when it is done, the page.
  useEffect(() => {
    if (!open) return
    setTab(streaming || !previewable || (initialPath && set.files.find(f => f.path === initialPath)?.kind === 'code') ? 'code' : 'preview')
  }, [open, streaming, previewable]) // eslint-disable-line react-hooks/exhaustive-deps

  const files = set.files
  const current = files.find(f => f.path === path) ?? (streaming ? files[files.length - 1] : files.find(f => f.path === set.entry) ?? files[0])

  // Publish the finished files to the preview server (once per version).
  useEffect(() => {
    if (!open || streaming || !messageId || !previewable) return
    const preview = previewFiles(set)
    if (!preview) return
    const key = `${online ? 1 : 0}:${JSON.stringify(preview)}`
    if (published.current === key) return
    let alive = true
    setPublishing(true)
    setError(null)
    window.api.workspace.publish(chatId, messageId, preview.files, preview.entry, online)
      .then(r => {
        if (!alive) return
        if (r.ok && r.url) {
          // Marked published only once it is; each version gets its own address so the frame reloads.
          published.current = key
          setFrameReady(false)
          setUrl(/^https?:/.test(r.url) ? `${r.url}?v=${++version.current}` : r.url)
        } else setError(r.error || t('workspace.previewFailed'))
      })
      .catch(err => { if (alive) setError(String(err?.message ?? err)) })
      .finally(() => { if (alive) setPublishing(false) })
    return () => { alive = false }
  }, [open, streaming, messageId, chatId, set, previewable, online, t])

  const codeRef = useRef<HTMLDivElement>(null)
  // Follow the code while it is being written.
  useEffect(() => {
    if (streaming && tab === 'code' && codeRef.current) codeRef.current.scrollTop = codeRef.current.scrollHeight
  }, [streaming, tab, current?.code])

  // Highlighting a whole page on every update is too slow while it is written: plain text until done.
  const highlighted = useMemo(() => !current ? '' : streaming ? escapeCodeHtml(current.code) : highlightCodeBlock(current.code, current.language), [current?.code, current?.language, streaming]) // eslint-disable-line react-hooks/exhaustive-deps

  const download = async () => {
    const preview = previewable ? previewFiles(set) : null
    const out = (preview?.files ?? files.map(f => ({ path: f.path, content: f.code })))
      .filter(f => f.path !== '__preview.html')
    const r = await window.api.workspace.save(out, set.title || 'Workspace')
    if (!r.ok && r.error) setError(r.error)
  }
  const copy = () => {
    if (!current) return
    void navigator.clipboard.writeText(current.code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  // Drag the left edge to resize.
  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    // Keep the pointer on the handle even over the page's frame.
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* not supported */ }
    const startX = e.clientX
    const startW = width
    setDragging(true)
    const max = Math.max(MIN_W, window.innerWidth * 0.72)
    const move = (ev: PointerEvent) => setWidth(Math.min(max, Math.max(MIN_W, startW + (startX - ev.clientX))))
    const up = () => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setWidth(w => { try { localStorage.setItem(WIDTH_KEY, String(Math.round(w))) } catch { /* convenience */ } return w })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [width])

  const kindIcon = set.entry && files.find(f => f.path === set.entry)?.kind === 'svg' ? ImageIcon : previewable ? Globe : FileCode2
  const Icon = kindIcon
  const writing = streaming && files.some(f => f.open)

  return (
    <aside data-vmlx-surface="workspace" aria-hidden={!open} {...(!open ? { inert: '' } : {})}
      className={`relative h-full shrink-0 overflow-hidden border-l border-border/70 bg-[rgb(var(--bg-rgb))] ${dragging ? '' : 'transition-[width,opacity] duration-[380ms] ease-mlx'} ${open ? 'opacity-100' : 'opacity-0'}`}
      style={{ width: open ? width : 0 }}>
      <div className="absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-0.5 cursor-col-resize hover:bg-primary/20" onPointerDown={startDrag} aria-hidden />
      <div className="flex h-full flex-col" style={{ width }}>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-semibold" title={set.title}>{set.title || t('workspace.title')}</p>
            <p className="flex items-center gap-1.5 truncate text-[11.5px] text-muted-foreground">
              {writing ? <><Spinner className="h-3 w-3" />{t('workspace.writing', { file: files.find(f => f.open)?.path ?? '' })}</>
                : t(files.length === 1 ? 'workspace.filesOne' : 'workspace.files', { n: files.length })}
            </p>
          </div>
          {previewable && (
            <div role="tablist" className="relative grid w-[148px] grid-cols-2 rounded-[8px] bg-[var(--seg-track)] p-[2px]">
              <div aria-hidden className="absolute bottom-[2px] left-[2px] top-[2px] rounded-[6px] bg-[var(--seg-thumb)] shadow-[var(--elev-1)] transition-transform duration-300 ease-mlx"
                style={{ width: 'calc((100% - 4px) / 2)', transform: `translateX(${tab === 'preview' ? 0 : 100}%)` }} />
              {(['preview', 'code'] as const).map(v => (
                <button key={v} type="button" role="tab" aria-selected={tab === v} onClick={() => setTab(v)} data-vmlx-control={`workspace-tab-${v}`}
                  className={`relative h-6 rounded-[6px] text-[12px] font-medium transition-colors ${tab === v ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                  {t(`workspace.${v}`)}
                </button>
              ))}
            </div>
          )}
          {tab === 'preview' && previewable && (
            <>
              <button type="button" className="mlx-icon-btn" title={t('workspace.reload')} aria-label={t('workspace.reload')}
                disabled={!url} onClick={() => { setFrameReady(false); setReload(n => n + 1) }}><RotateCw className="h-3.5 w-3.5" /></button>
              <button type="button" className="mlx-icon-btn" title={t('workspace.openBrowser')} aria-label={t('workspace.openBrowser')}
                disabled={!url} data-vmlx-control="workspace-open-browser" onClick={() => url && void window.api.workspace.openExternal(url)}><ExternalLink className="h-3.5 w-3.5" /></button>
            </>
          )}
          {tab === 'code' && current && (
            <button type="button" className="mlx-icon-btn" title={t('workspace.copy')} aria-label={t('workspace.copy')} onClick={copy}>
              {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          )}
          <Btn size="md" disabled={streaming || files.length === 0} data-vmlx-control="workspace-download" onClick={() => void download()}>
            <Download className="h-3.5 w-3.5" />{t('workspace.download')}
          </Btn>
          <button type="button" className="mlx-icon-btn" onClick={onClose} aria-label={t('common.close')} data-vmlx-control="workspace-close"><X className="h-4 w-4" /></button>
        </header>

        {(tab === 'code' || !previewable) && files.length > 1 && (
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 px-3 py-1.5" role="tablist">
            {files.map(f => (
              <button key={f.path} type="button" role="tab" aria-selected={current?.path === f.path} onClick={() => setPath(f.path)}
                className={`flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] px-2.5 font-mono text-[11.5px] transition-colors ${current?.path === f.path ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.05]'}`}>
                <Code2 className="h-3 w-3" />{f.path}{f.open && <Spinner className="h-3 w-3" />}
              </button>
            ))}
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          {/* Preview and code share one cell and cross-fade (no jump cut). */}
          <div className={`absolute inset-0 transition-opacity duration-300 ease-mlx ${tab === 'preview' && previewable ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
            {url && frameAlive && (
              // Its own origin (127.0.0.1:port), no popups, dialogs, downloads or navigation away.
              <iframe key={`${url}#${reload}`} src={url} title={set.title}
                sandbox="allow-scripts allow-same-origin allow-forms"
                className={`h-full w-full border-0 bg-white transition-opacity duration-300 ${frameReady ? 'opacity-100' : 'opacity-0'} ${dragging ? 'pointer-events-none' : ''}`}
                onLoad={() => setFrameReady(true)} data-vmlx-workspace-frame="" />
            )}
            {(!url || !frameReady) && (
              <div className="absolute inset-0 grid place-items-center text-[13px] text-muted-foreground">
                {error ? <p className="max-w-[80%] text-center text-destructive">{error}</p>
                  : streaming ? <p>{t('workspace.previewAfter')}</p>
                  : <span className="flex items-center gap-2"><Spinner />{publishing ? t('workspace.preparing') : t('workspace.loading')}</span>}
              </div>
            )}
          </div>
          <div ref={codeRef} className={`absolute inset-0 overflow-auto transition-opacity duration-300 ease-mlx ${tab === 'code' || !previewable ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
            {current ? (
              <pre className="m-0 min-h-full bg-transparent p-4 text-[12px] leading-[18px]"><code className={`hljs language-${current.language}`} dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
            ) : (
              <p className="p-6 text-center text-[13px] text-muted-foreground">{t('workspace.empty')}</p>
            )}
          </div>
        </div>
        {url && tab === 'preview' && (
          <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-border/60 px-3 text-[11.5px] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono" title={url}>{url.replace(/\?v=\d+$/, '')}</span>
            {online ? (
              <button type="button" className="text-[color:var(--link)] hover:underline" data-vmlx-control="workspace-offline"
                title={t('workspace.goOfflineTitle')} onClick={() => setOnline(false)}>{t('workspace.online')}</button>
            ) : (
              <button type="button" className="text-[color:var(--link)] hover:underline" data-vmlx-control="workspace-allow-internet"
                title={t('workspace.allowInternetTitle')} onClick={() => setOnline(true)}>{t('workspace.allowInternet')}</button>
            )}
            <span aria-hidden>·</span>
            <span>{t('workspace.localOnly')}</span>
          </footer>
        )}
      </div>
    </aside>
  )
}

/** The value, updated at most every `ms` (0: at once). The last value always lands. */
function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value)
  const last = useRef(0)
  useEffect(() => {
    if (!ms) { setShown(value); last.current = Date.now(); return }
    const wait = Math.max(0, last.current + ms - Date.now())
    const id = window.setTimeout(() => { last.current = Date.now(); setShown(value) }, wait)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return ms ? shown : value
}
