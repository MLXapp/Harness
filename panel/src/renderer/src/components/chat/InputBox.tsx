import { useState, useRef, useCallback, useEffect, KeyboardEvent, DragEvent, ClipboardEvent } from 'react'
import { Paperclip, ArrowUp, Square, ImagePlus, X, Film, Music, FileText } from 'lucide-react'
import { VoiceChat } from './VoiceChat'
import { ModelSwitcher } from './ModelSwitcher'
import { AgentModeChip, PlanHandoff } from '../code/AgentMode'
import { AppsButton } from '../apps/AppsButton'
import { useChatModel } from './ChatModelContext'
import { useVoiceInput } from './voiceInput'
import { useTranslation } from '../../i18n'
import { COMPOSER_FILL_EVENT, useWorkspaceKind } from '../code/workspaceKind'
import { apiCapabilityModalities } from '../../../../shared/apiModelCapabilities'

export type AttachmentKind = 'image' | 'video' | 'audio' | 'text'

export interface MediaAttachment {
  id: string
  kind: AttachmentKind
  dataUrl: string
  name: string
  type: string
  size: number
  text?: string
}

// Back-compat alias — older callers imported ImageAttachment when it was
// image-only. Keep the name exported so existing imports don't break.
export type ImageAttachment = MediaAttachment

interface InputBoxProps {
  onSend: (message: string, attachments?: MediaAttachment[]) => void
  onAbort?: () => void
  disabled?: boolean
  loading?: boolean
  sessionEndpoint?: { host: string; port: number }
  sessionId?: string
}

// Caps: images up to 10 MB, videos up to 100 MB (engine extracts frames
// smartly via OpenCV, so no reason to block reasonable clips locally),
// audio up to 50 MB for Omni / Parakeet paths, and text files up to 2 MB
// inlined as prompt context. Other binary files are intentionally not accepted.
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const VIDEO_MAX_BYTES = 100 * 1024 * 1024
const AUDIO_MAX_BYTES = 50 * 1024 * 1024
const TEXT_MAX_BYTES = 2 * 1024 * 1024

const ACCEPTED_IMAGE_TYPES = 'image/png,image/jpeg,image/gif,image/webp'
const ACCEPTED_VIDEO_TYPES = 'video/mp4,video/webm,video/quicktime,video/x-m4v'
const ACCEPTED_AUDIO_TYPES = 'audio/wav,audio/wave,audio/x-wav,audio/mpeg,audio/mp3,audio/flac,audio/ogg,audio/mp4,audio/x-m4a'
const ACCEPTED_TEXT_TYPES = 'text/plain,text/markdown,text/csv,application/json,application/xml,application/x-yaml'
const TEXT_FILE_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'yaml', 'yml',
  'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs',
  'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'swift', 'kt', 'sh', 'zsh', 'bash',
  'toml', 'ini', 'cfg', 'conf', 'log', 'sql',
])

function kindForFile(f: File): AttachmentKind | null {
  if (f.type.startsWith('image/')) return 'image'
  if (f.type.startsWith('video/')) return 'video'
  if (f.type.startsWith('audio/')) return 'audio'
  if (f.type.startsWith('text/')) return 'text'
  if (f.type === 'application/json' || f.type === 'application/xml' || f.type === 'application/x-yaml') return 'text'
  const ext = f.name.split('.').pop()?.toLowerCase()
  if (ext && TEXT_FILE_EXTENSIONS.has(ext)) return 'text'
  return null
}

function sizeLimitForKind(kind: AttachmentKind): number {
  if (kind === 'video') return VIDEO_MAX_BYTES
  if (kind === 'audio') return AUDIO_MAX_BYTES
  if (kind === 'text') return TEXT_MAX_BYTES
  return IMAGE_MAX_BYTES
}

/** A media file is refused at attach time only when the running engine ADVERTISES its modalities and that kind is
 * not among them (the server would answer the turn with a 400). Unknown or failed detection never restricts. */
// Large text pastes bypass Chromium's textarea editing path. Measured 2026-10-17 in the dev app: a 370k-character
// paste (an ~88k-token document) took 44-46 s through insertText (the path a real Cmd-V takes) and froze the
// renderer, while setting the same value through React state is immediate. At or above this size the paste is
// inserted at the selection through state (the browser's undo entry for that one paste is lost).
export const LARGE_PASTE_CHARS = 20000

export function insertPastedText(value: string, selStart: number, selEnd: number, text: string): { value: string, caret: number } {
  const start = Math.max(0, Math.min(selStart, value.length))
  const end = Math.max(start, Math.min(selEnd, value.length))
  return { value: value.slice(0, start) + text + value.slice(end), caret: start + text.length }
}

export function attachmentAllowed(kind: AttachmentKind, modalities: string[] | null): boolean {
  if (kind === 'text' || !modalities || modalities.length === 0) return true
  const names = modalities.map(m => m.toLowerCase())
  // The engine advertises images as "vision" (server _loaded_mllm_modalities: ["text", "vision", "video", ...]);
  // "image" is accepted too. Comparing the attachment kind literally refused every image on every VLM.
  if (kind === 'image') return names.includes('vision') || names.includes('image')
  return names.includes(kind)
}

/** Below this composer width the model pill shows only its glyph. */
export const COMPACT_COMPOSER_PX = 420

export function InputBox({ onSend, onAbort, disabled, loading, sessionEndpoint, sessionId }: InputBoxProps) {
  const { t } = useTranslation()
  const chatModel = useChatModel()
  // No model at all (no session, no provider model): Send waits for a choice.
  const noModel = !!chatModel && !chatModel.hasModel
  const voice = useVoiceInput()
  const composerRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    const el = composerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth
      setCompact(width < COMPACT_COMPOSER_PX)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const [message, setMessage] = useState('')
  const workspace = useWorkspaceKind()
  // Starter prompts (Code sessions) fill the composer and focus it.
  useEffect(() => {
    const fill = (e: Event) => {
      const text = (e as CustomEvent).detail?.text
      if (typeof text !== 'string') return
      setMessage(text)
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
    window.addEventListener(COMPOSER_FILL_EVENT, fill)
    return () => window.removeEventListener(COMPOSER_FILL_EVENT, fill)
  }, [])
  const [attachments, setAttachments] = useState<MediaAttachment[]>([])
  const [runtimeModalities, setRuntimeModalities] = useState<string[] | null>(null)
  const [attachNotice, setAttachNotice] = useState<string | null>(null)

  // Re-read on every engine start/stop of this session: a restart can change the modalities (e.g. Multimodal
  // Force Off -> Auto) without remounting the chat, which left a stale list refusing attachments.
  const [engineGeneration, setEngineGeneration] = useState(0)
  useEffect(() => {
    const sessions = (window as any).api?.sessions
    if (!sessionId || !sessions?.onReady || !sessions?.onStopped) return
    const bump = (data: any) => { if (data?.sessionId === sessionId) setEngineGeneration(g => g + 1) }
    const offReady = sessions.onReady(bump)
    const offStopped = sessions.onStopped(bump)
    return () => { offReady?.(); offStopped?.() }
  }, [sessionId])

  // The running engine's advertised modalities (same read-only, incarnation-keyed query as the server drawer).
  useEffect(() => {
    let cancelled = false
    setRuntimeModalities(null)
    if (!sessionId || !(window as any).api?.performance?.capabilities) return
    void (window as any).api.performance.capabilities(sessionId).then((reply: any) => {
      if (!cancelled) setRuntimeModalities(apiCapabilityModalities(reply?.capabilities))
    }).catch(() => { /* unknown: allow every kind */ })
    return () => { cancelled = true }
  }, [sessionId, loading, engineGeneration])

  useEffect(() => {
    if (!attachNotice) return
    const timer = setTimeout(() => setAttachNotice(null), 8000)
    return () => clearTimeout(timer)
  }, [attachNotice])
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea based on content
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.overflowY = el.scrollHeight > 200 ? 'auto' : 'hidden'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [message])

  // Auto-focus textarea when component mounts or loading completes
  useEffect(() => {
    if (!loading && !disabled) {
      textareaRef.current?.focus()
    }
  }, [loading, disabled])

  const handleSend = () => {
    if ((message.trim() || attachments.length > 0) && !disabled && !noModel) {
      onSend(message, attachments.length > 0 ? attachments : undefined)
      setMessage('')
      setAttachments([])
      // Reset file input so the same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Skip if IME is composing (CJK input: kanji/hangul selection uses Enter)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape' && loading && onAbort) {
      onAbort()
    }
  }

  const addFiles = useCallback((files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const kind = kindForFile(file)
      if (kind === null) continue
      if (file.size > sizeLimitForKind(kind)) {
        console.warn(`[InputBox] Skipping ${file.name}: ${file.size} bytes exceeds ${kind} limit`)
        continue
      }
      if (!attachmentAllowed(kind, runtimeModalities)) {
        setAttachNotice(t('chat.input.unsupportedAttachment', {
          kind, name: file.name, modalities: (runtimeModalities || []).join(' · '),
        }))
        continue
      }
      const reader = new FileReader()
      reader.onload = () => {
        setAttachments(prev => [...prev, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          kind,
          dataUrl: kind === 'text' ? '' : reader.result as string,
          name: file.name,
          type: file.type,
          size: file.size,
          text: kind === 'text' ? reader.result as string : undefined,
        }])
      }
      reader.onerror = () => {
        console.error('Failed to read file:', file.name, reader.error)
      }
      if (kind === 'text') {
        reader.readAsText(file)
      } else {
        reader.readAsDataURL(file)
      }
    }
  }, [runtimeModalities, t])

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    // Clipboard paste accepts images, videos, and audio. Text paste remains
    // normal textarea input; text files come via drop or picker.
    const mediaItems = Array.from(items).filter(i =>
      i.type.startsWith('image/') || i.type.startsWith('video/') || i.type.startsWith('audio/')
    )
    if (mediaItems.length === 0) {
      const text = e.clipboardData?.getData('text/plain') || ''
      const el = textareaRef.current
      if (text.length >= LARGE_PASTE_CHARS && el) {
        e.preventDefault()
        const next = insertPastedText(el.value, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, text)
        setMessage(next.value)
        requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = next.caret })
      }
      return
    }
    e.preventDefault()
    const files = mediaItems.map(item => item.getAsFile()).filter(Boolean) as File[]
    addFiles(files)
  }, [addFiles])

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    if (e.dataTransfer?.files) {
      addFiles(e.dataTransfer.files)
    }
  }, [addFiles])

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    // Only clear drag state when leaving the container entirely (not entering a child)
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setIsDragOver(false)
  }, [])

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }

  const handleTranscription = useCallback((text: string) => {
    setMessage(prev => prev ? prev + ' ' + text : text)
  }, [])

  // Apple Dictation: the composer takes focus, then macOS shows its Dictation
  // UI at the caret and types into the textarea (main/dictation.ts).
  const handleDictate = useCallback(async () => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
    try {
      await window.api.dictation?.start()
    } catch (error) {
      console.error('Dictation failed to start:', error)
    }
  }, [])

  const canSend = !disabled && !noModel && (!!message.trim() || attachments.length > 0)
  const sendTitle = noModel ? t('chat.switcher.chooseFirst') : t('chat.input.sendTitle')

  return (
    <div
      className={`relative mx-auto w-full max-w-[868px] px-6 pb-5 pt-2 transition-colors ${isDragOver ? 'bg-primary/5' : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 border-2 border-dashed border-primary/40 rounded-lg m-1 pointer-events-none">
          <div className="flex flex-col items-center gap-1 text-primary">
            <ImagePlus className="h-6 w-6" />
            <span className="text-xs font-medium">{t('chat.input.dropOverlay')}</span>
          </div>
        </div>
      )}

      {attachNotice && (
        <div
          className="mb-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-foreground"
          role="status"
          data-vmlx-control="chat-attach-notice"
        >
          {attachNotice}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="flex gap-2 mb-3 flex-wrap">
          {attachments.map(att => (
            <div key={att.id} className="relative group">
              {att.kind === 'audio' ? (
                <div className="h-20 w-20 rounded-lg border border-border bg-muted flex flex-col items-center justify-center overflow-hidden text-muted-foreground">
                  <Music className="h-6 w-6" />
                  <span className="mt-1 max-w-[72px] truncate text-[11px]">{t('endpoints.audio')}</span>
                </div>
              ) : att.kind === 'text' ? (
                <div className="h-20 w-20 rounded-lg border border-border bg-muted flex flex-col items-center justify-center overflow-hidden text-muted-foreground">
                  <FileText className="h-6 w-6" />
                  <span className="mt-1 max-w-[72px] truncate text-[11px]">{t('chat.input.textAttachment')}</span>
                </div>
              ) : att.kind === 'video' ? (
                <div className="h-20 w-20 rounded-lg border border-border bg-black flex items-center justify-center overflow-hidden">
                  <video
                    src={att.dataUrl}
                    className="h-full w-full object-cover"
                    muted
                    preload="metadata"
                  />
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <Film className="h-6 w-6 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" />
                  </div>
                </div>
              ) : (
                <img
                  src={att.dataUrl}
                  alt={att.name}
                  className="h-20 w-20 object-cover rounded-lg border border-border"
                />
              )}
              <button
                onClick={() => removeAttachment(att.id)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-3 w-3" />
              </button>
              <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[11px] px-1 truncate rounded-b-lg">
                {att.name}
              </div>
            </div>
          ))}
        </div>
      )}

      {workspace === 'code' && <PlanHandoff loading={!!loading} onSend={(text) => onSend(text)} />}
      <div
        ref={composerRef}
        data-vmlx-surface="chat-composer"
        className="mlx-composer"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={`${ACCEPTED_IMAGE_TYPES},${ACCEPTED_VIDEO_TYPES},${ACCEPTED_AUDIO_TYPES},${ACCEPTED_TEXT_TYPES}`}
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) addFiles(e.target.files) }}
        />
        <textarea
          data-vmlx-control="chat-composer"
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={loading ? t('chat.input.placeholderWaiting') : workspace === 'code' ? t('code.placeholder') : t('chat.input.placeholderDefault')}
          disabled={disabled && !loading}
          className="block w-full resize-none bg-transparent px-4 pb-1 pt-3 min-h-[48px] max-h-[240px] text-[15px] leading-[1.5] text-foreground placeholder:text-muted-foreground focus:outline-none"
          rows={1}
        />
        <div className="flex items-center gap-1 px-2 pb-2 pt-1">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            data-vmlx-control="chat-attach"
            disabled={disabled && !loading}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
            title={t('chat.input.attachTitle')}
            aria-label={t('chat.input.attachTitle')}
          >
            <Paperclip className="h-[18px] w-[18px]" />
          </button>
          <ModelSwitcher compact={compact} />
          {workspace === 'code' && <AgentModeChip compact={compact} />}
          <AppsButton compact={compact} />
          <div className="min-w-0 flex-1" />
          <VoiceChat
            onTranscription={handleTranscription}
            endpoint={sessionEndpoint}
            sessionId={sessionId}
            disabled={disabled && !loading}
            mode={voice.mode}
            onDictate={handleDictate}
          />
          {loading ? (
            <button
              type="button"
              onClick={onAbort}
              data-vmlx-control="chat-stop"
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-[opacity,transform] duration-150 hover:opacity-85 active:scale-95"
              title={t('chat.input.stopTitle')}
              aria-label={t('chat.input.stopTitle')}
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              data-vmlx-control="chat-send"
              disabled={!canSend}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[color:var(--acc)] text-white shadow-[0_4px_14px_-6px_var(--acc-glow)] transition-[background-color,opacity,transform,box-shadow] duration-150 hover:bg-[color:var(--acc-hi)] active:scale-95 disabled:opacity-35 disabled:shadow-none disabled:active:scale-100"
              title={sendTitle}
              aria-label={sendTitle}
            >
              <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
