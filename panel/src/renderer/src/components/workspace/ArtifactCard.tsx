import { useMemo } from 'react'
import { FileCode2, Globe } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { extractArtifacts, hasPreview, worthACard } from '../../../../shared/artifacts'
import { useWorkspace } from './context'
import { Reveal } from '../ui/Reveal'

/** The card under a reply that made files: opens them in the workspace. */
export function ArtifactCard({ messageId, content, streaming }: { messageId: string; content: string; streaming: boolean }) {
  const { t } = useTranslation()
  const ws = useWorkspace()
  // Parsed once the reply is done (the workspace panel follows a reply as it is written).
  const set = useMemo(() => (streaming ? null : extractArtifacts(content)), [content, streaming])
  if (!set || !worthACard(set)) return null
  const previewable = hasPreview(set)
  const active = ws.activeMessageId === messageId
  const names = set.files.map(f => f.path)
  const Icon = previewable ? Globe : FileCode2
  return (
    <Reveal open>
    <button type="button" onClick={() => ws.open(messageId)} data-vmlx-artifact-card={messageId}
      className={`mt-3 flex w-full max-w-[460px] items-center gap-3 rounded-[12px] border px-3 py-2.5 text-left transition-[background-color,border-color] duration-200 ${active ? 'border-primary/50 bg-primary/[0.06]' : 'border-border/70 bg-foreground/[0.02] hover:bg-foreground/[0.05]'}`}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] bg-foreground/[0.06]"><Icon className="h-4 w-4 text-muted-foreground" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold">{set.title}</span>
        <span className="block truncate text-[11.5px] text-muted-foreground">
          {names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ')}
        </span>
      </span>
      <span className="shrink-0 text-[12px] font-medium text-primary">{previewable ? t('workspace.openPreview') : t('workspace.openFiles')}</span>
    </button>
    </Reveal>
  )
}
