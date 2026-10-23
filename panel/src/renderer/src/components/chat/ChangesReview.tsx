/**
 * Changes review. Under a reply whose turn changed files: "3 files changed
 * +42 −7  Review". The review sheet lists the files and shows each diff;
 * Revert puts a file (or all of them) back as it was before the turn, and
 * refuses a file that changed since unless you confirm. Click a line to
 * comment on it; "Send 2 comments" hands them to the agent (they join a
 * running reply, or start the next one).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FileMinus2, FilePen, FilePlus2, FolderSearch, MessageSquarePlus, RotateCcw, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { changeTotals, type FileChange, type FileTexts, type TurnChangeSet } from '../../../../shared/changes'
import { lineDiff, type DiffOp } from '../../../../shared/lineDiff'
import { Reveal } from '../ui/Reveal'
import { Btn, countKey } from '../accounts/ui'

interface ChangesValue {
  byMessage: Map<string, TurnChangeSet>
  open: (messageId: string) => void
}

const ChangesContext = createContext<ChangesValue>({ byMessage: new Map(), open: () => {} })

/** Loads a chat's change sets and keeps them current; renders the sheet. */
export function ChangesProvider({ chatId, onSendComments, children }: {
  chatId: string | null
  onSendComments: (text: string) => void
  children: ReactNode
}) {
  const [sets, setSets] = useState<Map<string, TurnChangeSet>>(new Map())
  const [openId, setOpenId] = useState<string | null>(null)
  useEffect(() => {
    setSets(new Map())
    setOpenId(null)
    const api = window.api.changes
    if (!chatId || !api) return
    let alive = true
    api.list(chatId).then(list => { if (alive) setSets(new Map(list.map(s => [s.messageId, s]))) }).catch(() => undefined)
    const off = api.onTurn(set => {
      if (set.chatId !== chatId) return
      setSets(prev => new Map(prev).set(set.messageId, set))
    })
    return () => { alive = false; off() }
  }, [chatId])
  const value = useMemo<ChangesValue>(() => ({ byMessage: sets, open: setOpenId }), [sets])
  const openSet = openId ? sets.get(openId) ?? null : null
  return (
    <ChangesContext.Provider value={value}>
      {children}
      <ChangesSheet set={openSet} onClose={() => setOpenId(null)} onSendComments={text => { setOpenId(null); onSendComments(text) }} />
    </ChangesContext.Provider>
  )
}

/** The line under a reply. Nothing when its turn changed no files. */
export function TurnChangesPill({ messageId }: { messageId: string }) {
  const { t } = useTranslation()
  const { byMessage, open } = useContext(ChangesContext)
  const set = byMessage.get(messageId)
  const totals = set ? changeTotals(set) : null
  return (
    <Reveal open={!!totals} appear={false}>
      {totals && (
        <button type="button" data-vmlx-control="changes-pill" onClick={() => open(messageId)}
          className="mlx-changes-pill mt-3">
          <FilePen className="h-3.5 w-3.5 text-primary" />
          <span className="font-medium text-foreground">{t(countKey('changes.files', totals.files), { n: totals.files })}</span>
          <Counts added={totals.added} removed={totals.removed} className="text-[11.5px]" />
          {totals.reverted > 0 && (
            <span className="text-muted-foreground">· {totals.reverted === totals.files ? t('changes.allReverted') : t('changes.someReverted', { n: totals.reverted })}</span>
          )}
          <span className="ml-1 text-[color:var(--link)]">{t('changes.review')}</span>
        </button>
      )}
    </Reveal>
  )
}

const EXIT_MS = 240
type Comment = { path: string; shown: string; line: number; side: 'a' | 'b'; code: string; text: string }

function ChangesSheet({ set, onClose, onSendComments }: { set: TurnChangeSet | null; onClose: () => void; onSendComments: (text: string) => void }) {
  const { t } = useTranslation()
  // Kept while the sheet animates out.
  const [shownSet, setShownSet] = useState<TurnChangeSet | null>(set)
  const [shown, setShown] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [conflicts, setConflicts] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (set) {
      setShownSet(set)
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
    const id = window.setTimeout(() => { setShownSet(null); setComments([]); setConflicts([]); setNotice(null) }, EXIT_MS)
    return () => window.clearTimeout(id)
  }, [set])
  // A new version of the same set (after a revert) replaces the shown one.
  useEffect(() => { if (set) setShownSet(set) }, [set])
  useEffect(() => {
    if (!shownSet) return
    if (!selected || !shownSet.files.some(f => f.path === selected)) setSelected(shownSet.files[0]?.path ?? null)
  }, [shownSet]) // eslint-disable-line react-hooks/exhaustive-deps
  // Focus moves in once when the sheet opens and back once when it closes;
  // a new version of the set (after a revert) or a re-render (a reply
  // streaming next to it) must not move it.
  const isOpen = !!set
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!isOpen) return
    const before = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeRef.current() }
    }
    window.addEventListener('keydown', onKey)
    panelRef.current?.focus()
    return () => { window.removeEventListener('keydown', onKey); if (before && document.contains(before)) requestAnimationFrame(() => before.focus()) }
  }, [isOpen])

  if (!shownSet) return null
  const totals = changeTotals(shownSet)
  const file = shownSet.files.find(f => f.path === selected) ?? null

  const revert = async (paths: string[], force = false) => {
    if (!window.api.changes) return
    setBusy(true)
    setNotice(null)
    try {
      const r = await window.api.changes.revert(shownSet.chatId, shownSet.messageId, paths, force)
      setConflicts(r.conflicts)
      if (r.failed.length) setNotice(t(countKey('changes.failed', r.failed.length), { n: r.failed.length }))
      else if (r.reverted.length) setNotice(t(countKey('changes.revertedN', r.reverted.length), { n: r.reverted.length }))
    } catch {
      setNotice(t(countKey('changes.failed', paths.length || shownSet.files.length), { n: paths.length || shownSet.files.length }))
    } finally {
      setBusy(false)
    }
  }
  const send = () => {
    if (comments.length === 0) return
    const lines = comments.map(c => `- ${c.shown}:${c.line}${c.code.trim() ? ` (\`${c.code.trim().slice(0, 80)}\`)` : ''}: ${c.text.trim()}`)
    onSendComments(`${t('changes.commentsIntro')}\n${lines.join('\n')}`)
    setComments([])
  }

  return createPortal(
    <div className={`mlx-sheet-root ${shown ? 'is-shown' : ''}`} data-vmlx-surface="changes-review">
      <div className="mlx-sheet-scrim" onMouseDown={onClose} aria-hidden />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={t('changes.title')} tabIndex={-1}
        className="mlx-sheet mlx-changes"
        onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && comments.length) { e.preventDefault(); send() } }}>
        <header className="mlx-changes-head">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">{t('changes.title')}</h2>
            <p className="text-[12.5px] text-muted-foreground">
              {t(countKey('changes.files', totals.files), { n: totals.files })}{(totals.added > 0 || totals.removed > 0) && ' · '}<Counts added={totals.added} removed={totals.removed} />
            </p>
          </div>
          <Btn variant="plain" size="md" disabled={busy || totals.reverted === totals.files}
            data-vmlx-control="changes-revert-all" onClick={() => void revert([])}>
            <RotateCcw className="h-3.5 w-3.5" />{t('changes.revertAll')}
          </Btn>
          <button type="button" onClick={onClose} className="mlx-icon-btn" aria-label={t('common.close')}><X className="h-4 w-4" /></button>
        </header>
        <Reveal open={conflicts.length > 0 || !!notice}>
          <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-2 text-[12.5px]">
            {conflicts.length > 0 ? (
              <>
                <span className="min-w-0 flex-1 text-warning">{t(countKey('changes.conflict', conflicts.length), { n: conflicts.length })}</span>
                <Btn variant="plain" size="md" onClick={() => setConflicts([])}>{t('common.cancel')}</Btn>
                <Btn variant="plain" size="md" className="text-destructive" disabled={busy} onClick={() => void revert(conflicts, true)}>{t('changes.revertAnyway')}</Btn>
              </>
            ) : <span className="text-muted-foreground" role="status">{notice}</span>}
          </div>
        </Reveal>
        <div className="mlx-changes-body">
          <nav className="mlx-changes-files" aria-label={t('changes.title')}>
            {shownSet.files.map(f => (
              <button key={f.path} type="button" onClick={() => setSelected(f.path)} aria-current={f.path === selected ? 'true' : undefined}
                className={`mlx-changes-file ${f.path === selected ? 'is-on' : ''} ${f.reverted ? 'is-reverted' : ''}`} title={f.shown}>
                <KindIcon kind={f.kind} />
                <span className="min-w-0 flex-1 truncate text-left">{baseName(f.shown)}<span className="block truncate text-[11px] text-muted-foreground">{dirName(f.shown)}</span></span>
                {f.reverted ? <span className="text-[11px] text-muted-foreground">{t('changes.reverted')}</span>
                  : <Counts added={f.added} removed={f.removed} className="text-[11px]" />}
              </button>
            ))}
          </nav>
          <section className="min-w-0 flex min-h-0 flex-col">
            {file && (
              <FileDiff key={`${shownSet.messageId}:${file.path}:${file.reverted ? 1 : 0}`} set={shownSet} file={file} busy={busy}
                comments={comments.filter(c => c.path === file.path)}
                onComment={c => setComments(cs => [...cs.filter(x => !(x.path === c.path && x.line === c.line && x.side === c.side)), ...(c.text.trim() ? [c] : [])])}
                onRevert={() => void revert([file.path])} />
            )}
          </section>
        </div>
        <Reveal open={comments.length > 0}>
          <footer className="mlx-changes-foot">
            <span className="flex-1 text-[12.5px] text-muted-foreground">{t('changes.commentsHint')}</span>
            <Btn variant="plain" size="md" onClick={() => setComments([])}>{t('changes.discard')}</Btn>
            <Btn variant="primary" size="lg" data-vmlx-control="changes-send-comments" onClick={send}>
              {t(countKey('changes.send', comments.length), { n: comments.length })}<kbd className="ml-1.5 opacity-70">⌘↩</kbd>
            </Btn>
          </footer>
        </Reveal>
      </div>
    </div>,
    document.body,
  )
}

function KindIcon({ kind }: { kind: FileChange['kind'] }) {
  const { t } = useTranslation()
  const Icon = kind === 'added' ? FilePlus2 : kind === 'deleted' ? FileMinus2 : FilePen
  const color = kind === 'added' ? 'text-success' : kind === 'deleted' ? 'text-destructive' : 'text-primary'
  return <Icon className={`h-4 w-4 shrink-0 ${color}`} aria-label={t(`changes.kind.${kind}`)} />
}

/** "+12 −3", leaving out a side that is zero. */
function Counts({ added, removed, className = '' }: { added: number; removed: number; className?: string }) {
  if (!added && !removed) return null
  return (
    <span className={`font-mono ${className}`}>
      {added > 0 && <span className="text-success">+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className="text-destructive">−{removed}</span>}
    </span>
  )
}

const baseName = (p: string) => p.split('/').pop() || p
const dirName = (p: string) => { const parts = p.split('/'); parts.pop(); return parts.join('/') }

function FileDiff({ set, file, busy, comments, onComment, onRevert }: {
  set: TurnChangeSet
  file: FileChange
  busy: boolean
  comments: Comment[]
  onComment: (c: Comment) => void
  onRevert: () => void
}) {
  const { t } = useTranslation()
  const [texts, setTexts] = useState<FileTexts | null>(null)
  const [editing, setEditing] = useState<{ line: number; side: 'a' | 'b'; code: string } | null>(null)
  useEffect(() => {
    let alive = true
    window.api.changes?.file(set.chatId, set.messageId, file.path).then(r => { if (alive) setTexts(r) }).catch(() => setTexts(null))
    return () => { alive = false }
  }, [set.chatId, set.messageId, file.path])
  const diff = useMemo(() => (texts && !texts.opaque ? lineDiff(texts.before, texts.after) : null), [texts])
  const commentAt = useCallback((line: number, side: 'a' | 'b') => comments.find(c => c.line === line && c.side === side), [comments])

  return (
    <>
      <div className="mlx-changes-filehead">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={file.path}>{file.shown}</span>
        <button type="button" className="mlx-icon-btn h-7 w-7" title={t('changes.reveal')} aria-label={t('changes.reveal')}
          onClick={() => void window.api.changes?.reveal(set.chatId, set.messageId, file.path)}><FolderSearch className="h-3.5 w-3.5" /></button>
        <Btn variant="plain" size="md" disabled={busy || !!file.reverted || !file.revertible}
          data-vmlx-control="changes-revert-file" onClick={onRevert}
          title={!file.revertible ? t('changes.cantRevert') : undefined}>
          <RotateCcw className="h-3.5 w-3.5" />{file.reverted ? t('changes.reverted') : t('changes.revertFile')}
        </Btn>
      </div>
      <div className="mlx-changes-diff" role="table" aria-label={file.shown}>
        {!texts ? null
          : texts.opaque ? <p className="p-5 text-[13px] text-muted-foreground">{t('changes.opaque')}</p>
          : diff && diff.hunks.length === 0 ? <p className="p-5 text-[13px] text-muted-foreground">{t('changes.noLines')}</p>
          // A whole-file rewrite of thousands of lines: say so instead of drawing every line.
          : diff && diff.coarse && diff.added + diff.removed > 3000 ? <p className="p-5 text-[13px] text-muted-foreground" data-vmlx-section="changes-too-big">{t('changes.tooBig', { added: diff.added, removed: diff.removed })}</p>
          : diff?.hunks.map((h, hi) => (
            <div key={hi} className="mlx-hunk">
              <div className="mlx-hunk-head">{t('changes.atLine', { n: h.bStart })}</div>
              {h.lines.map((op, li) => {
                const side: 'a' | 'b' = op.type === 'del' ? 'a' : 'b'
                const line = (side === 'a' ? op.a : op.b) ?? 0
                const existing = commentAt(line, side)
                const isEditing = editing && editing.line === line && editing.side === side
                return (
                  <div key={li}>
                    <DiffLine op={op} onComment={() => setEditing({ line, side, code: op.text })} hasComment={!!existing} label={t('changes.comment')} />
                    {isEditing ? (
                      <CommentBox initial={existing?.text ?? ''} autoFocus
                        onSave={text => { onComment({ path: file.path, shown: file.shown, line, side, code: op.text, text }); setEditing(null) }}
                        onCancel={() => setEditing(null)} />
                    ) : existing ? (
                      <div className="mlx-comment is-saved">
                        <p className="whitespace-pre-wrap text-[13px] leading-[18px]">{existing.text}</p>
                        <div className="flex justify-end gap-1.5">
                          <Btn variant="plain" size="md" onClick={() => onComment({ ...existing, text: '' })}>{t('changes.removeComment')}</Btn>
                          <Btn variant="plain" size="md" onClick={() => setEditing({ line, side, code: op.text })}>{t('changes.editComment')}</Btn>
                        </div>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ))}
        {texts?.changedSince && <p className="px-5 py-3 text-[12px] text-warning">{t('changes.changedSince')}</p>}
      </div>
    </>
  )
}

function DiffLine({ op, onComment, hasComment, label }: { op: DiffOp; onComment: () => void; hasComment: boolean; label: string }) {
  const cls = op.type === 'add' ? 'is-add' : op.type === 'del' ? 'is-del' : ''
  return (
    <div className={`mlx-dl ${cls}`} role="row">
      <span className="mlx-dl-n" role="cell">{op.a ?? ''}</span>
      <span className="mlx-dl-n" role="cell">{op.b ?? ''}</span>
      <span className="mlx-dl-sign" aria-hidden>{op.type === 'add' ? '+' : op.type === 'del' ? '−' : ''}</span>
      <span className="mlx-dl-code" role="cell">{op.text || ' '}</span>
      <button type="button" className={`mlx-dl-add ${hasComment ? 'is-on' : ''}`} onClick={onComment} aria-label={label} title={label}>
        <MessageSquarePlus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function CommentBox({ initial, autoFocus, onSave, onCancel }: { initial: string; autoFocus: boolean; onSave: (text: string) => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState(initial)
  return (
    <div className="mlx-comment">
      <textarea value={text} onChange={e => setText(e.target.value)} autoFocus={autoFocus} rows={2} placeholder={t('changes.commentPlaceholder')}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); onCancel() }
          if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSave(text) }
        }} />
      <div className="flex justify-end gap-1.5">
        <Btn variant="plain" size="md" onClick={() => (initial ? onSave('') : onCancel())}>{initial ? t('changes.removeComment') : t('common.cancel')}</Btn>
        <Btn variant="plain" size="md" className="text-[color:var(--link)]" disabled={!text.trim()} onClick={() => onSave(text)}>{t('changes.addComment')}</Btn>
      </div>
    </div>
  )
}
