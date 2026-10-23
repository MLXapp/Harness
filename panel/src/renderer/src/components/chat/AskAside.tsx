/**
 * Ask aside (⌘;): a quick side question about the open chat, answered by the
 * chat's own model without tools, and never added to the conversation. Works
 * while a reply is running. A local model reuses the chat's cache, so it is
 * nearly free. "Ask in Chat" sends the question as a normal message instead.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { renderChatMarkdownHtml } from './mathMarkdown'
import { sanitizeChatHtml } from './sanitizeChatHtml'
import { Copy, CornerDownLeft, MessageCircleQuestion, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Reveal } from '../ui/Reveal'
import { Btn, Spinner } from '../accounts/ui'

export function AskAside({ chatId, endpoint, onAskInChat }: {
  chatId: string | null
  endpoint?: { host: string; port: number }
  onAskInChat: (text: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const askId = useRef(0)

  useEffect(() => {
    const onOpen = () => {
      if (!chatId) return
      setOpen(o => {
        if (!o) requestAnimationFrame(() => inputRef.current?.focus())
        return !o
      })
    }
    window.addEventListener('vmlx:ask-aside', onOpen)
    return () => window.removeEventListener('vmlx:ask-aside', onOpen)
  }, [chatId])
  // Another chat: start fresh.
  useEffect(() => { setOpen(false); setQuestion(''); setAnswer(null); setError(null); setBusy(false) }, [chatId])

  const ask = async () => {
    const q = question.trim()
    if (!q || !chatId || busy || !window.api.chat.aside) return
    const id = ++askId.current
    setBusy(true); setError(null); setAnswer(null)
    try {
      const r = await window.api.chat.aside(chatId, q, endpoint)
      if (id !== askId.current) return
      if (r?.success && r.text) setAnswer(r.text)
      else setError(r?.error && r.error !== 'aborted' ? t('aside.failed') : t('aside.empty'))
    } catch {
      if (id === askId.current) setError(t('aside.failed'))
    } finally {
      if (id === askId.current) setBusy(false)
    }
  }
  // Same safe pipeline as reasoning text: markdown, KaTeX, then sanitized.
  const answerHtml = useMemo(() => answer ? sanitizeChatHtml(renderChatMarkdownHtml(answer)) : '', [answer])
  const close = () => { setOpen(false); askId.current++ ; setBusy(false) }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-full z-30 pb-1">
      {/* Same column as the composer below (max 868 px with 24 px gutters). */}
      <div className="mx-auto w-full max-w-[868px] px-6">
        {/* The clip box reaches 12 px past the card so its shadow isn't cut off. */}
        <div className="-mx-3 -mb-3">
        <Reveal open={open}>
          <div className="p-3 pt-0">
          <div className="mlx-aside pointer-events-auto" role="dialog" aria-label={t('aside.title')} data-vmlx-surface="ask-aside"
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() } }}>
            <div className="flex items-center gap-2">
              <MessageCircleQuestion className="h-4 w-4 shrink-0 text-[color:var(--sys-blue)]" />
              <span className="flex-1 text-[13px] font-semibold">{t('aside.title')}</span>
              <span className="text-[11.5px] text-muted-foreground">{t('aside.hint')}</span>
              <button type="button" onClick={close} className="mlx-icon-btn h-6 w-6" aria-label={t('common.close')}><X className="h-3.5 w-3.5" /></button>
            </div>
            <form className="mt-2 flex items-end gap-2" onSubmit={e => { e.preventDefault(); void ask() }}>
              <textarea ref={inputRef} value={question} onChange={e => setQuestion(e.target.value)} rows={1}
                data-vmlx-control="ask-aside-input" placeholder={t('aside.placeholder')}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask() }
                }}
                className="max-h-28 min-h-[34px] min-w-0 flex-1 resize-none rounded-[10px] border border-input bg-background px-3 py-[7px] text-[13.5px] leading-[19px] focus:outline-none focus:ring-2 focus:ring-ring/50" />
              <Btn type="submit" size="lg" disabled={!question.trim() || busy} data-vmlx-control="ask-aside-send">
                {busy ? <Spinner /> : <CornerDownLeft className="h-3.5 w-3.5" />}{t('aside.ask')}
              </Btn>
            </form>
            <Reveal open={!!answer || !!error}>
              <div className="mt-2.5">
                {error ? <p className="text-[13px] text-muted-foreground" role="status">{error}</p> : (
                  <>
                    <div className="mlx-aside-answer prose prose-invert max-w-none prose-code:before:content-none prose-code:after:content-none max-h-[38vh] overflow-auto break-words rounded-[10px] bg-[rgb(var(--bg-3-rgb)/0.6)] px-3 py-2 text-[13.5px] leading-[20px] select-text [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_pre]:my-1.5"
                      data-vmlx-section="ask-aside-answer" dangerouslySetInnerHTML={{ __html: answerHtml }} />
                    <div className="mt-2 flex justify-end gap-1.5">
                      <Btn variant="plain" size="md" onClick={() => { void navigator.clipboard?.writeText(answer ?? ''); setCopied(true); window.setTimeout(() => setCopied(false), 1400) }}>
                        <Copy className="h-3.5 w-3.5" />{copied ? t('aside.copied') : t('aside.copy')}
                      </Btn>
                      <Btn variant="plain" size="md" onClick={() => { const q = question.trim(); close(); setQuestion(''); setAnswer(null); onAskInChat(q) }}>{t('aside.inChat')}</Btn>
                    </div>
                  </>
                )}
              </div>
            </Reveal>
          </div>
          </div>
        </Reveal>
        </div>
      </div>
    </div>
  )
}
