// The install window's page: one self-contained document (inline style and
// script, no network, strict CSP), drawn in MLX Harness's own look (window
// glass, the MLX orange, SF Pro) and animated without jump cuts: screens
// cross-fade on a fixed stage, texts fade when they change, the bar glides.
// Main sends finished screens (shared/appInstall.ts InstallerScreen) through
// the sandboxed preload (src/preload/installer.ts).

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c])
}

export interface InstallerPageInput {
  lang: string
  /** Window title (also read by VoiceOver). */
  title: string
  /** data:image/png;base64,… of the app icon. */
  iconDataUrl: string
  /** "Version 0.5.5 · Built on vMLX by JANGQ AI" */
  footer: string
}

const CSS = `
:root {
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, "Helvetica Neue", sans-serif;
  --text: #1D1D1F; --dim: #565B66; --faint: #868C97;
  --acc: #F08A00; --acc-hi: #FF9F0A; --on-acc: #1A1000; --brand-a: #1D1D1F;
  --wash: linear-gradient(to bottom, rgba(255, 159, 10, 0.12), rgba(255, 159, 10, 0) 42%, rgba(255, 90, 46, 0) 70%, rgba(255, 90, 46, 0.06)), rgba(246, 246, 248, 0.6);
  --btn: rgba(0, 0, 0, 0.06); --btn-hover: rgba(0, 0, 0, 0.09); --hair: rgba(0, 0, 0, 0.09);
  --track: rgba(0, 0, 0, 0.08); --rim: rgba(255, 255, 255, 0.55);
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --text: #F5F5F7; --dim: #A1A6B0; --faint: #7A808B;
    --acc: #FFA21A; --acc-hi: #FFB43F; --brand-a: #F5F5F7;
    --wash: linear-gradient(to bottom, rgba(255, 159, 10, 0.10), rgba(255, 159, 10, 0) 42%, rgba(255, 90, 46, 0) 70%, rgba(255, 90, 46, 0.06)), rgba(30, 30, 33, 0.55);
    --btn: rgba(255, 255, 255, 0.1); --btn-hover: rgba(255, 255, 255, 0.15); --hair: rgba(255, 255, 255, 0.1);
    --track: rgba(255, 255, 255, 0.12); --rim: rgba(255, 255, 255, 0.18);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; }
body {
  font: 13px/1.45 var(--font); color: var(--text); background: var(--wash);
  -webkit-user-select: none; user-select: none; cursor: default;
  -webkit-font-smoothing: antialiased;
}
.drag { position: fixed; inset: 0 0 auto 0; height: 40px; -webkit-app-region: drag; }
main { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; padding: 34px 28px 18px; }
.icon {
  width: 84px; height: 84px; flex: none;
  animation: rise 700ms var(--ease) both;
}
.icon.busy { animation: rise 700ms var(--ease) both, breathe 2.4s ease-in-out 700ms infinite; }
.stage { position: relative; flex: 1; width: 100%; margin-top: 10px; }
.screen {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; text-align: center;
  opacity: 0; transform: translateY(8px); pointer-events: none;
  transition: opacity 260ms var(--ease), transform 420ms var(--ease);
}
.screen.on { opacity: 1; transform: none; pointer-events: auto; }
.screen.off { opacity: 0; transform: translateY(-6px); }
h1 {
  margin: 0 0 6px; max-width: 360px; font-size: 15.5px; font-weight: 600; line-height: 1.3; letter-spacing: -0.01em;
  text-wrap: balance;
}
p { margin: 0; max-width: 360px; color: var(--dim); font-size: 12.5px; text-wrap: pretty; }
p.note { margin-top: 4px; color: var(--faint); font-variant-numeric: tabular-nums; }
.swap { transition: opacity 160ms ease; }
.swap.fading { opacity: 0; }
.bottom { position: absolute; left: 0; right: 0; bottom: 0; height: 30px; display: flex; align-items: center; justify-content: center; }
.actions { display: flex; gap: 10px; }
button {
  -webkit-appearance: none; appearance: none; border: 0; margin: 0; font: 500 13px/1 var(--font);
  height: 28px; min-width: 96px; padding: 0 16px; border-radius: 7px; color: var(--text); background: var(--btn);
  box-shadow: inset 0 0 0 0.5px var(--hair);
  transition: background-color 160ms var(--ease), transform 120ms var(--ease), box-shadow 160ms var(--ease);
}
button:hover { background: var(--btn-hover); }
button:active { transform: scale(0.98); }
button:focus { outline: none; }
.kbd button:focus-visible { box-shadow: inset 0 0 0 0.5px var(--hair), 0 0 0 3px rgba(240, 138, 0, 0.45); }
button.primary {
  color: var(--on-acc); font-weight: 600;
  background: linear-gradient(to bottom, var(--acc-hi), var(--acc));
  box-shadow: inset 0 0.5px 0 var(--rim), 0 0.5px 1px rgba(0, 0, 0, 0.18), 0 2px 8px -3px rgba(240, 138, 0, 0.55);
}
button.primary:hover { filter: brightness(1.05); }
.kbd button.primary:focus-visible { box-shadow: inset 0 0.5px 0 var(--rim), 0 0 0 3px rgba(240, 138, 0, 0.45); }
.bar { position: relative; width: 300px; height: 6px; border-radius: 3px; overflow: hidden; background: var(--track); }
.fill {
  position: absolute; inset: 0; border-radius: 3px; transform: translateX(-100%);
  background: linear-gradient(90deg, var(--acc), var(--acc-hi));
  will-change: transform;
}
.fill::after {
  content: ""; position: absolute; inset: 0; border-radius: 3px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.55) 50%, rgba(255, 255, 255, 0) 100%);
  background-size: 40% 100%; background-repeat: no-repeat;
  animation: sheen 1.6s linear infinite;
}
footer { flex: none; margin-top: 12px; font-size: 11px; color: var(--faint); }
@keyframes rise { from { opacity: 0; transform: translateY(6px) scale(0.96); } to { opacity: 1; transform: none; } }
@keyframes breathe { 0%, 100% { transform: none; } 50% { transform: translateY(-2px) scale(1.015); } }
@keyframes sheen { from { background-position: -60% 0; } to { background-position: 160% 0; } }
@media (prefers-reduced-motion: reduce) {
  .screen { transform: none !important; transition: opacity 200ms ease; }
  .icon, .icon.busy { animation: none; }
  .fill::after { animation: none; display: none; }
}
`

// Screens alternate between two layers: a new key fades the old one out and
// the new one in; the same key only updates texts (soft fade) and the bar.
/** The page's script. Written to a file next to the page: the app's session policy (script-src 'self') blocks inline
 * scripts, so the page loads it with <script src>. */
export const INSTALLER_SCRIPT = `
(() => {
  const stage = document.getElementById('stage')
  const icon = document.getElementById('icon')
  let current = null
  let shownKey = null
  let target = 0, shown = 0, raf = 0
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches

  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }
  function setText(node, text, counter) {
    text = text || ''
    if (node.textContent === text) return
    // A running count ("0.6 GB of 1.6 GB") just ticks; words fade.
    if (counter && node.textContent && text) { node.textContent = text; return }
    node.classList.add('fading')
    setTimeout(() => { node.textContent = text; node.classList.remove('fading') }, 160)
  }
  function glide() {
    raf = 0
    const d = target - shown
    shown = Math.abs(d) < 0.0005 ? target : shown + d * (reduce ? 0.35 : 0.12)
    if (current && current.fill) current.fill.style.transform = 'translateX(' + ((shown - 1) * 100).toFixed(3) + '%)'
    if (shown !== target) raf = requestAnimationFrame(glide)
  }
  function setProgress(p) {
    target = Math.max(target, Math.max(0, Math.min(1, p)))
    if (!raf) raf = requestAnimationFrame(glide)
  }
  function button(spec, primary) {
    const b = el('button', primary ? 'primary' : '', spec.label)
    b.type = 'button'
    b.dataset.action = spec.action
    b.addEventListener('click', () => {
      for (const x of stage.querySelectorAll('button')) x.disabled = true
      window.installer.act(spec.action)
    })
    return b
  }
  function build(s) {
    const root = el('section', 'screen')
    root.setAttribute('role', 'group')
    const h = el('h1', 'swap', s.title)
    const p = el('p', 'swap', s.text)
    const n = el('p', 'note swap', s.note || '')
    root.append(h, p, n)
    const bottom = el('div', 'bottom')
    let fill = null
    if (typeof s.progress === 'number') {
      const bar = el('div', 'bar')
      bar.setAttribute('role', 'progressbar')
      bar.setAttribute('aria-valuemin', '0')
      bar.setAttribute('aria-valuemax', '100')
      fill = el('div', 'fill')
      bar.append(fill)
      bottom.append(bar)
    } else {
      const actions = el('div', 'actions')
      if (s.secondary) actions.append(button(s.secondary, false))
      if (s.primary) actions.append(button(s.primary, true))
      bottom.append(actions)
    }
    root.append(bottom)
    return { root, h, p, n, fill, bar: fill && fill.parentElement }
  }
  function show(s) {
    if (!s || typeof s !== 'object') return
    icon.classList.toggle('busy', typeof s.progress === 'number')
    if (current && shownKey === s.key) {
      setText(current.h, s.title); setText(current.p, s.text); setText(current.n, s.note || '', typeof s.progress === 'number')
      for (const b of current.root.querySelectorAll('button')) b.disabled = false
      if (typeof s.progress === 'number') {
        setProgress(s.progress)
        current.bar && current.bar.setAttribute('aria-valuenow', String(Math.round(s.progress * 100)))
      }
      return
    }
    const next = build(s)
    stage.append(next.root)
    const prev = current
    current = next
    shownKey = s.key
    if (typeof s.progress === 'number') {
      target = 0; shown = 0
      next.fill.style.transform = 'translateX(-100%)'
      setProgress(s.progress)
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      next.root.classList.add('on')
      const first = next.root.querySelector('button.primary') || next.root.querySelector('button')
      if (first) first.focus({ preventScroll: true })
    }))
    if (prev) {
      prev.root.classList.remove('on')
      prev.root.classList.add('off')
      for (const b of prev.root.querySelectorAll('button')) b.disabled = true
      setTimeout(() => prev.root.remove(), 480)
    }
  }
  // Focus rings only once the keyboard is used (Return still presses the default button).
  document.addEventListener('mousedown', () => document.documentElement.classList.remove('kbd'))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') document.documentElement.classList.add('kbd')
    if (e.key === 'Escape' && current) {
      const quit = current.root.querySelector('button[data-action="quit"]')
      if (quit && !quit.disabled) { e.preventDefault(); quit.click() }
    }
  })
  window.installer.onScreen(show)
  window.installer.ready()
})()
`

export function installerPage(x: InstallerPageInput & { script: string }): string {
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'self'"
  return `<!doctype html>
<html lang="${esc(x.lang)}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${esc(x.title)}</title>
<style>${CSS}</style>
</head><body>
<div class="drag"></div>
<main>
  <img id="icon" class="icon" src="${esc(x.iconDataUrl)}" alt="" draggable="false">
  <div id="stage" class="stage" aria-live="polite"></div>
  <footer>${esc(x.footer)}</footer>
</main>
<script src="${esc(x.script)}"></script>
</body></html>`
}
