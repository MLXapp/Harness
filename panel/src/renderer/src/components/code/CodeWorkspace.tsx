import { useState, type ReactNode } from 'react'
import { Eye, FolderOpen, PenLine, ShieldAlert, SquareTerminal, type LucideIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { FEATURED_CLOUD_MODELS, featuredAccount } from '../../../../shared/curated'
import { AccountGlyph } from '../accounts/AccountGlyph'
import { readStored, writeStored } from '../media/hooks'
import { WorkspaceKindContext } from './workspaceKind'
import { CodeModeContext, type CodeModeValue } from './AgentMode'

export type AccessMode = 'read-only' | 'workspace' | 'full'

export interface CodeStart {
  folder: string
  access: AccessMode
}

const RECENT_KEY = 'mlx.code.recentFolders'
const ACCESS_KEY = 'mlx.code.access'

const ACCESS: Array<[AccessMode, LucideIcon]> = [
  ['read-only', Eye],
  ['workspace', PenLine],
  ['full', ShieldAlert],
]

export function recentFolders(): string[] {
  try {
    const list = JSON.parse(readStored(RECENT_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, 6) : []
  } catch {
    return []
  }
}

export function rememberFolder(folder: string): void {
  writeStored(RECENT_KEY, JSON.stringify([folder, ...recentFolders().filter(f => f !== folder)].slice(0, 6)))
}

const folderName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

/**
 * The Code tab. A Code session is a chat whose agent works on one project
 * folder (file, search, shell and git tools) at a chosen access level. With
 * no session open it shows the start screen: folder, access, a word on
 * models. With one open it shows the chat with a project bar above it.
 */
export function CodeWorkspace({ codeDirectory, mode, onStart, children }: {
  /** The open chat's project folder, when it is a Code session. */
  codeDirectory: string | null
  /** The session's agent mode (the composer's mode chip changes it). */
  mode: CodeModeValue
  onStart: (start: CodeStart) => Promise<void> | void
  /** The chat view for an open session. */
  children: ReactNode
}) {
  if (codeDirectory) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ProjectBar folder={codeDirectory} />
        <WorkspaceKindContext.Provider value="code">
          <CodeModeContext.Provider value={mode}>
            <div className="min-h-0 flex-1">{children}</div>
          </CodeModeContext.Provider>
        </WorkspaceKindContext.Provider>
      </div>
    )
  }
  return <CodeHome onStart={onStart} />
}

function CodeHome({ onStart }: { onStart: (start: CodeStart) => Promise<void> | void }) {
  const { t } = useTranslation()
  const [folder, setFolder] = useState<string | null>(() => recentFolders()[0] ?? null)
  const [access, setAccess] = useState<AccessMode>(() => {
    const saved = readStored(ACCESS_KEY)
    return saved === 'read-only' || saved === 'full' ? saved : 'workspace'
  })
  const [starting, setStarting] = useState(false)
  const recents = recentFolders()

  const choose = async () => {
    const result = await window.api.chat.openDirectory()
    if (result && !result.canceled && result.filePaths?.[0]) setFolder(result.filePaths[0])
  }
  const start = async () => {
    if (!folder || starting) return
    setStarting(true)
    rememberFolder(folder)
    writeStored(ACCESS_KEY, access)
    try { await onStart({ folder, access }) } finally { setStarting(false) }
  }
  const codeModels = FEATURED_CLOUD_MODELS.filter(m => m.purposes.includes('code')).slice(0, 3)

  return (
    <div data-vmlx-surface="code-home" className="h-full overflow-y-auto px-6 py-10">
      <div className="mx-auto flex max-w-[620px] flex-col items-center text-center mlx-view-in">
        <div className="mlx-hero-tile"><SquareTerminal className="h-8 w-8" strokeWidth={1.7} /></div>
        <h2 className="mt-5 text-[26px] font-semibold tracking-[-0.02em]">{t('code.title')}</h2>
        <p className="mt-2 max-w-[520px] text-[15px] leading-[22px] text-muted-foreground">{t('code.subtitle')}</p>
      </div>

      <div className="mx-auto mt-8 max-w-[620px] space-y-4 mlx-view-in">
        <section className="mlx-group p-4">
          <h3 className="text-[13px] font-semibold">{t('code.folder')}</h3>
          <div className="mt-2.5 flex items-center gap-2">
            <button type="button" data-vmlx-control="code-choose-folder" onClick={() => void choose()}
              className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-[11px] bg-[rgb(var(--bg-3-rgb)/0.7)] px-3 text-left text-[14px] hover:bg-[rgb(var(--bg-3-rgb))]">
              <FolderOpen className="h-[18px] w-[18px] shrink-0 text-primary" strokeWidth={1.8} />
              {folder
                ? <span className="min-w-0 truncate"><span className="font-medium">{folderName(folder)}</span> <span className="text-muted-foreground">{folder}</span></span>
                : <span className="text-muted-foreground">{t('code.chooseFolder')}</span>}
            </button>
          </div>
          {recents.length > 1 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {recents.map(path => (
                <button key={path} type="button" title={path} onClick={() => setFolder(path)}
                  className={`mlx-chip ${path === folder ? 'is-on' : ''}`}>{folderName(path)}</button>
              ))}
            </div>
          )}
        </section>

        <section className="mlx-group p-4">
          <h3 className="text-[13px] font-semibold">{t('code.access')}</h3>
          <div role="radiogroup" aria-label={t('code.access')} className="mt-2.5 grid grid-cols-3 gap-2">
            {ACCESS.map(([mode, Icon]) => (
              <button key={mode} type="button" role="radio" aria-checked={access === mode} data-vmlx-control={`code-access-${mode}`}
                onClick={() => setAccess(mode)}
                className={`relative flex flex-col items-start gap-1 rounded-[12px] p-3 text-left transition-[box-shadow,background-color] duration-200 ${access === mode
                  ? 'bg-[rgb(var(--primary)/0.10)] shadow-[0_0_0_1.5px_rgb(var(--primary)/0.65)]'
                  : 'bg-[rgb(var(--bg-3-rgb)/0.55)] hover:bg-[rgb(var(--bg-3-rgb))]'}`}>
                <Icon className={`h-[18px] w-[18px] ${mode === 'full' ? 'text-warning' : access === mode ? 'text-primary' : 'text-muted-foreground'}`} strokeWidth={1.8} />
                <span className="text-[13.5px] font-medium">{t(`code.mode.${mode}`)}</span>
                {mode === 'workspace' && <span className="mlx-badge">{t('code.recommended')}</span>}
              </button>
            ))}
          </div>
          <p key={access} className="mt-2.5 text-[13px] leading-[19px] text-muted-foreground mlx-fade-in">{t(`code.modeHelp.${access}`)}</p>
        </section>

        <section className="mlx-group p-4">
          <h3 className="text-[13px] font-semibold">{t('code.models')}</h3>
          <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">{t('code.modelsHelp')}</p>
          <ul className="mt-2.5 space-y-1.5">
            {codeModels.map(m => (
              <li key={m.key} className="flex items-center gap-2.5 text-[13.5px]">
                <AccountGlyph providerId={featuredAccount(m.account)?.catalogId} size={20} />
                <span className="font-medium">{m.name}</span>
                <span className="truncate text-muted-foreground">{m.blurb}</span>
                {m.badge && <span className="mlx-badge ml-auto">{m.badge === 'Best value' ? t('media.badge.value') : m.badge === 'Best' ? t('media.badge.best') : t('media.badge.fast')}</span>}
              </li>
            ))}
            <li className="flex items-center gap-2.5 text-[13.5px]">
              <AccountGlyph local size={20} />
              <span className="font-medium">{t('code.localModel')}</span>
              <span className="truncate text-muted-foreground">{t('code.localModelHelp')}</span>
            </li>
          </ul>
        </section>

        <div className="flex justify-end pt-1">
          <button type="button" data-vmlx-control="code-start" disabled={!folder || starting} onClick={() => void start()} className="mlx-generate">
            <SquareTerminal className="h-4 w-4" strokeWidth={2} />{t('code.start')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Above an open Code session: the project folder (the mode lives in the composer). */
function ProjectBar({ folder }: { folder: string }) {
  return (
    <div data-vmlx-section="code-project-bar" className="flex h-11 shrink-0 items-center gap-2 px-5 mlx-hair-b">
      <FolderOpen className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.8} />
      <span className="truncate text-[13.5px] font-medium" title={folder}>{folderName(folder)}</span>
      <span className="hidden min-w-0 truncate text-[12.5px] text-muted-foreground md:inline">{folder}</span>
    </div>
  )
}
