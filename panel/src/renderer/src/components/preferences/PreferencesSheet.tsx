import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Blocks, BookOpen, Brain, Check, ChevronDown, Cpu, Info, KeyRound, SlidersHorizontal, UserRound, X, type LucideIcon } from 'lucide-react'
import { useAppState } from '../../contexts/AppStateContext'
import { useTranslation, LOCALES, LOCALE_NAMES, LOCALE_FLAGS } from '../../i18n'
import { useTheme, type ThemePreference } from '../../providers/ThemeProvider'
import type { PreferencesSection } from '../../types/app-state'
import { SingleModelPreference } from '../layout/SingleModelPreference'
import { AccountsPreference } from '../accounts/AccountsPreference'
import { MlxNodePreference } from '../network/MlxNodePreference'
import { ApiKeysSection } from './ApiKeysSection'
import { AppsPreference } from '../apps/AppsPreference'
import { SkillsPreference } from '../apps/SkillsPreference'
import { MemoryPreference } from './MemoryPreference'

const SECTIONS: Array<[PreferencesSection, LucideIcon]> = [
  ['general', SlidersHorizontal],
  ['accounts', UserRound],
  ['apps', Blocks],
  ['skills', BookOpen],
  ['memory', Brain],
  ['node', Cpu],
  ['keys', KeyRound],
  ['about', Info],
]
const ROW = 34
const GAP = 2
const EXIT_MS = 220

/**
 * Preferences, as a sheet over the window (System Settings-like): a section
 * list on the left, one section on the right. The only place for the app's
 * language and appearance. Opens from the sidebar, ⌘, and any "Settings" link;
 * Esc, the close button or a click on the dimmed window closes it.
 */
export function PreferencesSheet() {
  const { state, dispatch } = useAppState()
  const { t } = useTranslation()
  const open = state.preferences !== null
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const [section, setSection] = useState<PreferencesSection>(state.preferences ?? 'general')
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (state.preferences) setSection(state.preferences) }, [state.preferences])

  // Mount, then fade in on the next frame; fade out, then unmount.
  useEffect(() => {
    if (open) {
      setMounted(true)
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
    const id = window.setTimeout(() => setMounted(false), EXIT_MS)
    return () => window.clearTimeout(id)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dispatch({ type: 'CLOSE_PREFERENCES' }) }
    window.addEventListener('keydown', onKey)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, dispatch])

  if (!mounted) return null
  const close = () => dispatch({ type: 'CLOSE_PREFERENCES' })
  const go = (s: PreferencesSection) => { setSection(s); dispatch({ type: 'OPEN_PREFERENCES', section: s }) }
  const index = SECTIONS.findIndex(([s]) => s === section)

  return createPortal(
    <div className={`mlx-sheet-root ${shown ? 'is-shown' : ''}`} data-vmlx-surface="general-preferences">
      <div className="mlx-sheet-scrim" onMouseDown={close} aria-hidden />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={t('console.preferences')} tabIndex={-1}
        className="mlx-sheet mlx-prefs">
        <aside className="mlx-prefs-nav">
          <h2 className="px-3 pt-1 pb-3 text-[15px] font-semibold">{t('console.preferences')}</h2>
          <nav className="relative" aria-label={t('console.preferences')}>
            <div aria-hidden className="absolute left-0 right-0 rounded-[9px] bg-[var(--sidebar-row)] transition-transform duration-300 ease-mlx"
              style={{ height: ROW, transform: `translateY(${Math.max(0, index) * (ROW + GAP)}px)` }} />
            <div className="relative flex flex-col" style={{ gap: GAP }}>
              {SECTIONS.map(([s, Icon]) => (
                <button key={s} type="button" data-vmlx-control={`preferences-section-${s}`}
                  aria-current={section === s ? 'page' : undefined} onClick={() => go(s)} style={{ height: ROW }}
                  className={`flex items-center gap-2.5 px-3 rounded-[9px] text-[13.5px] text-left ${section === s ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-[var(--sidebar-hover)]'}`}>
                  <Icon className={`h-[17px] w-[17px] shrink-0 ${section === s ? 'text-primary' : ''}`} strokeWidth={1.8} />
                  <span className="truncate">{t(`shell.prefs.${s}`)}</span>
                </button>
              ))}
            </div>
          </nav>
        </aside>
        <div className="mlx-prefs-main">
          <div className="mlx-prefs-head">
            <h3 key={section} className="text-[19px] font-semibold tracking-[-0.01em] mlx-fade-in">{t(`shell.prefs.${section}`)}</h3>
            <button type="button" onClick={close} data-vmlx-control="preferences-close"
              title={t('common.close')} aria-label={t('common.close')} className="mlx-icon-btn">
              <X className="h-[18px] w-[18px]" strokeWidth={1.8} />
            </button>
          </div>
          <div key={section} className="mlx-prefs-body mlx-view-in">
            {section === 'general' && <GeneralSection />}
            {section === 'accounts' && <AccountsPreference embedded />}
            {section === 'apps' && <AppsPreference />}
            {section === 'skills' && <SkillsPreference />}
            {section === 'memory' && <MemoryPreference />}
            {section === 'node' && <MlxNodePreference />}
            {section === 'keys' && <ApiKeysSection />}
            {section === 'about' && <AboutSection />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function GeneralSection() {
  const { t } = useTranslation()
  return (
    <div className="space-y-5">
      <div className="mlx-group divide-y divide-[var(--hair)]">
        <Row label={t('app.about.appearance')}><AppearancePreference /></Row>
        <Row label={t('app.about.language')}><LanguageMenu /></Row>
      </div>
      <SingleModelPreference />
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 min-h-[52px] py-2">
      <span className="text-[13.5px]">{label}</span>
      {children}
    </div>
  )
}

/** System / Light / Dark. A segmented control whose selection slides. */
function AppearancePreference() {
  const { t } = useTranslation()
  const { preference, setPreference } = useTheme()
  const options: Array<[ThemePreference, string]> = [
    ['system', t('app.about.themeSystem')],
    ['light', t('app.about.themeLight')],
    ['dark', t('app.about.themeDark')],
  ]
  const index = Math.max(0, options.findIndex(([value]) => value === preference))
  return (
    <div role="radiogroup" aria-label={t('app.about.appearance')} data-vmlx-surface="appearance-preference"
      className="relative grid grid-cols-3 w-[264px] rounded-[10px] bg-[var(--seg-track)] p-[3px]">
      <div aria-hidden
        className="absolute top-[3px] bottom-[3px] left-[3px] rounded-[8px] bg-[var(--seg-thumb)] shadow-[var(--elev-1)] transition-transform duration-300 ease-mlx"
        style={{ width: 'calc((100% - 6px) / 3)', transform: `translateX(${index * 100}%)` }} />
      {options.map(([value, label]) => (
        <button key={value} role="radio" aria-checked={preference === value}
          data-vmlx-control={`preferences-theme-${value}`}
          onClick={() => setPreference(value)}
          className={`relative h-7 text-[13px] font-medium rounded-[8px] transition-colors ${preference === value ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
          {label}
        </button>
      ))}
    </div>
  )
}

/** The app's language: a pop-up button like macOS, the list in a glass menu. */
function LanguageMenu() {
  const { t, locale, setLocale } = useTranslation()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const r = buttonRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 6, right: window.innerWidth - r.right })
    const away = (e: MouseEvent) => {
      const target = e.target as Node
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc, true) }
  }, [open])

  return (
    <>
      <button ref={buttonRef} type="button" data-vmlx-locale-picker="true" data-vmlx-supported-locales={LOCALES.join(',')}
        aria-haspopup="menu" aria-expanded={open} title={t('titlebar.languageTitle')}
        onClick={() => setOpen(o => !o)} className="mlx-popup-btn">
        <span aria-hidden>{LOCALE_FLAGS[locale]}</span>
        <span>{LOCALE_NAMES[locale]}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} role="menu" className="mlx-menu fixed min-w-[200px] mlx-menu-in"
          style={{ top: pos.top, right: pos.right, zIndex: 2147483647 }}>
          {LOCALES.map((l) => (
            <button key={l} role="menuitemradio" aria-checked={locale === l}
              data-vmlx-locale-option={l} data-vmlx-control={`preferences-locale-${l}`}
              onClick={() => { setLocale(l); setOpen(false) }}
              className="mlx-menu-item">
              <span aria-hidden className="w-5 text-center">{LOCALE_FLAGS[l]}</span>
              <span className="flex-1">{LOCALE_NAMES[l]}</span>
              {locale === l && <Check className="h-4 w-4 text-primary" />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}

function AboutSection() {
  const { t } = useTranslation()
  const [version, setVersion] = useState('...')
  useEffect(() => {
    window.api.app.getVersion().then((v: string) => setVersion(v)).catch(() => setVersion('unknown'))
  }, [])
  return (
    <section className="space-y-4">
      <div className="mlx-group p-5 space-y-2">
        <p className="text-[15px] font-semibold">{t('app.about.title')}</p>
        <p className="text-[13.5px] text-muted-foreground">{t('app.about.desc')}</p>
        <p className="text-[13px] text-muted-foreground">{t('app.about.creator')}</p>
        <div className="text-[12px] text-muted-foreground space-y-1 pt-1">
          <p>{t('app.about.version', { version })}</p>
          <p>{t('app.about.copyright', { year: new Date().getFullYear() })}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-4 text-[13px] px-1">
        <a href="https://harness.mlx.app" target="_blank" rel="noopener noreferrer" className="text-[color:var(--link)] hover:underline">harness.mlx.app</a>
        <a href="https://github.com/MLXapp/harness" target="_blank" rel="noopener noreferrer" className="text-[color:var(--link)] hover:underline">GitHub</a>
        <a href="https://github.com/jjang-ai/vmlx" target="_blank" rel="noopener noreferrer" className="text-[color:var(--link)] hover:underline">vMLX</a>
        <a href="https://github.com/deepseek-ai/deepseek-harness" target="_blank" rel="noopener noreferrer" className="text-[color:var(--link)] hover:underline">DeepSeek Harness</a>
        <a href="https://github.com/MLXapp/harness/blob/main/NOTICE" target="_blank" rel="noopener noreferrer" className="text-[color:var(--link)] hover:underline">{t('app.about.license')}</a>
      </div>
      {/* Required in-product attribution (MTPLX NOTICE, Apache-2.0 §4(d)). */}
      <p className="text-[12px] text-muted-foreground px-1">
        <a data-vmlx-control="about-mtplx" href="https://github.com/youssofal/mtplx" target="_blank" rel="noopener noreferrer" className="hover:underline">
          {`${t('app.about.poweredByMtplx')} · github.com/youssofal/mtplx`}
        </a>
      </p>
    </section>
  )
}
