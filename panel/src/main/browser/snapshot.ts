/**
 * Page scripts for the agent browser (pure, no Electron import, so tests can
 * run them in any Chromium). Each export is a self-contained JavaScript string
 * for webContents.executeJavaScript / page.evaluate. Arguments are embedded
 * with JSON.stringify, never spliced in as raw text.
 *
 * The snapshot is a compact accessibility-style outline of the page:
 *
 *   [heading] Pricing
 *   [link e3] Sign in → /login
 *   [textbox e7 "Email"] value=""
 *   [button e8] Continue
 *
 * Interactive elements get a ref (eN) kept in a data-mlx-ref attribute, so a
 * ref stays the same across snapshots of the same document. Refs are unique
 * per document; after a navigation they start again from e1.
 */

export const REF_ATTR = 'data-mlx-ref'
export const SNAPSHOT_MAX_CHARS = 12_000
export const MORE_BELOW = '…(more below, use scroll)'

export interface SnapshotResult {
  url: string
  title: string
  text: string
}

export interface ScriptResult {
  ok: boolean
  error?: string
  [key: string]: unknown
}

export type ScrollDirection = 'up' | 'down' | 'top' | 'bottom'

/** "e8", "8", "[e8]", " E8 " → "e8"; anything else → null. */
export function normalizeRef(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return `e${raw}`
  if (typeof raw !== 'string') return null
  const m = /^\s*\[?\s*e?(\d{1,7})\s*\]?\s*$/i.exec(raw)
  return m ? `e${Number(m[1])}` : null
}

/**
 * Finds an element by ref in the document, open shadow roots and same-origin
 * iframes (the snapshot walks all three). Shared by the action scripts.
 */
/**
 * Refs map to elements in a registry the scripts keep in their own world
 * (Harness runs them in an isolated world, so the page cannot see or change
 * it). The data-mlx-ref attribute is only a hint for reuse: a page that moves
 * or copies it cannot point a ref at a different element.
 */
const REFS = String.raw`
  function __refs() {
    var m = window.__mlxRefMap;
    if (!(m instanceof Map)) {
      m = new Map();
      try { Object.defineProperty(window, '__mlxRefMap', { value: m, writable: false, configurable: false, enumerable: false }); } catch (e) {}
    }
    return m;
  }
`

/**
 * Finds the element a ref was given to, if it is still in the document (the
 * snapshot walks open shadow roots and same-origin iframes too). Shared by the
 * action scripts.
 */
const FIND = String.raw`
  ${REFS}
  function __find(root, ref) {
    var el = __refs().get(ref);
    return el && el.isConnected ? el : null;
  }
  function __missing(ref) {
    return { ok: false, error: 'No element ' + ref + ' on this page (it may have changed). Use a ref from the latest snapshot.' };
  }
  function __disabled(el) {
    return !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || (el.closest && el.closest('fieldset[disabled]')));
  }
  function __setter(el) {
    var p = Object.getPrototypeOf(el);
    while (p) {
      var d = Object.getOwnPropertyDescriptor(p, 'value');
      if (d && d.set) return d.set;
      p = Object.getPrototypeOf(p);
    }
    return null;
  }
  function __into(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
  }
`

const SNAPSHOT_SRC = String.raw`
function (MAX) {
  var topDoc = document;
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, svg: 1, SVG: 1, CANVAS: 1, OBJECT: 1, EMBED: 1, MAP: 1, DATALIST: 1, OPTION: 1, OPTGROUP: 1 };
  var ROLE_INTERACTIVE = { button: 1, link: 1, checkbox: 1, radio: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, option: 1, 'switch': 1, combobox: 1, textbox: 1, searchbox: 1, slider: 1, spinbutton: 1, treeitem: 1, listbox: 1 };
  var NAME_INSIDE = { textbox: 1, searchbox: 1, combobox: 1, listbox: 1, checkbox: 1, radio: 1, 'switch': 1, slider: 1, spinbutton: 1, file: 1 };
  var LANDMARK_TAG = { NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary', DIALOG: 'dialog', FORM: 'form' };
  var LANDMARK_ROLE = { navigation: 1, main: 1, complementary: 1, dialog: 1, alertdialog: 1, search: 1, form: 1, alert: 1, status: 1, banner: 1, contentinfo: 1, region: 0 };
  var INTERACTIVE_SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable=true],[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=combobox],[role=textbox],[role=option],[onclick]';
  var TEXT_TYPES = { text: 1, email: 1, url: 1, tel: 1, password: 1, search: 1, number: 1, date: 1, 'datetime-local': 1, month: 1, week: 1, time: 1, '': 1 };

  var lines = [];       // { t: string, above: boolean }
  var shownChars = 0;   // chars of lines that are not above the viewport
  var full = false;
  var visited = 0;
  var depth = 0;
  var prefix = '';
  var buf = '', bufEl = null;
  var used = {};

  var seq = 0;
  try { seq = Number(window.__mlxRefSeq) || 0; } catch (e) {}
  var existing = topDoc.querySelectorAll('[${REF_ATTR}]');
  for (var x = 0; x < existing.length; x++) {
    var m = /^e(\d+)$/.exec(existing[x].getAttribute('${REF_ATTR}') || '');
    if (m && Number(m[1]) > seq) seq = Number(m[1]);
  }

  function clean(s, n) {
    s = String(s == null ? '' : s).replace(/[\s ​]+/g, ' ').trim();
    if (n && s.length > n) s = s.slice(0, n - 1).trim() + '…';
    return s;
  }
  function q(s) { return JSON.stringify(s); }

  ${REFS}
  var REFMAP = __refs();
  REFMAP.forEach(function (v, k) { if (!v || !v.isConnected) REFMAP.delete(k); });
  function refFor(el) {
    var r = el.getAttribute('${REF_ATTR}');
    if (r && /^e\d+$/.test(r) && !used[r] && REFMAP.get(r) === el) { used[r] = 1; return r; }
    seq++;
    r = 'e' + seq;
    el.setAttribute('${REF_ATTR}', r);
    REFMAP.set(r, el);
    used[r] = 1;
    return r;
  }

  // Visible text of a subtree, for names. Skips form controls and hidden parts.
  function textIn(node, out) {
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { out.push(c.nodeValue); continue; }
      if (c.nodeType !== 1) continue;
      var t = c.tagName;
      if (SKIP[t] || t === 'SELECT' || t === 'TEXTAREA' || t === 'INPUT') {
        if (t === 'svg' || t === 'SVG') {
          var tt = c.getAttribute('aria-label') || (c.querySelector('title') || {}).textContent;
          if (tt) out.push(' ' + tt + ' ');
        }
        continue;
      }
      if (c.getAttribute('aria-hidden') === 'true' || c.hidden) continue;
      if (t === 'IMG') { var alt = c.getAttribute('alt'); if (alt) out.push(' ' + alt + ' '); continue; }
      if (t === 'BR') { out.push(' '); continue; }
      var cs = c.ownerDocument.defaultView.getComputedStyle(c);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      var block = cs.display.indexOf('inline') !== 0 && cs.display !== 'contents';
      if (block) out.push(' ');
      textIn(c.shadowRoot || c, out);
      if (block) out.push(' ');
    }
    return out;
  }
  function visText(el) { return clean(textIn(el, []).join('')); }

  function byIds(el, ids) {
    var d = el.getRootNode && el.getRootNode() || el.ownerDocument;
    return ids.split(/\s+/).map(function (id) {
      var n = (d.getElementById ? d.getElementById(id) : null) || el.ownerDocument.getElementById(id);
      return n ? visText(n) || clean(n.textContent) : '';
    }).join(' ');
  }

  function ariaName(el) {
    var v = el.getAttribute('aria-labelledby');
    if (v) { v = clean(byIds(el, v)); if (v) return v; }
    v = clean(el.getAttribute('aria-label'));
    return v;
  }

  function fieldName(el) {
    var v = ariaName(el);
    if (v) return v;
    if (el.labels && el.labels.length) {
      v = clean(Array.prototype.map.call(el.labels, function (l) { return visText(l); }).join(' '));
      if (v) return v;
    }
    v = clean(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('title'));
    if (v) return v;
    if (el.tagName === 'INPUT' && el.type === 'image') return clean(el.alt);
    if (!/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return visText(el) || clean(el.getAttribute('title'));
    return '';
  }

  function ownName(el, role) {
    var v = ariaName(el);
    if (v) return v;
    if (el.tagName === 'INPUT') {
      var t = (el.type || '').toLowerCase();
      if (t === 'submit' || t === 'reset' || t === 'button') return clean(el.value) || (t === 'reset' ? 'Reset' : t === 'submit' ? 'Submit' : '');
      if (t === 'image') return clean(el.alt || el.value || 'Submit');
    }
    v = visText(el);
    if (v) return v;
    v = clean(el.getAttribute('title'));
    if (v) return v;
    if (role === 'link') {
      var h = el.getAttribute('href') || '';
      return clean(h.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop());
    }
    return '';
  }

  function roleOf(el) {
    var r = (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    if (r && ROLE_INTERACTIVE[r]) return r;
    var t = el.tagName;
    if (t === 'A' || t === 'AREA') return el.hasAttribute('href') ? 'link' : '';
    if (t === 'BUTTON') return 'button';
    if (t === 'SUMMARY') return 'summary';
    if (t === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'INPUT') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return '';
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'range') return 'slider';
      if (type === 'file') return 'file';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    if (el.hasAttribute('onclick')) return 'button';
    return '';
  }

  function shortHref(el) {
    var raw = el.getAttribute('href');
    if (!raw || raw === '#' || /^\s*javascript:/i.test(raw)) return '';
    try {
      var u = new URL(raw, el.ownerDocument.baseURI);
      if (u.protocol === 'mailto:' || u.protocol === 'tel:') return clean(u.href, 60);
      var here = el.ownerDocument.location;
      var s = (u.origin === here.origin ? '' : u.host) + u.pathname + u.search;
      if (u.origin === here.origin && u.pathname === here.pathname && u.search === here.search) s = u.hash || '';
      return clean(s, 60);
    } catch (e) { return ''; }
  }

  function states(el, role) {
    var out = [];
    var t = el.tagName;
    if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      var ac = el.getAttribute('aria-checked');
      var on = t === 'INPUT' ? el.checked : ac === 'true';
      out.push(ac === 'mixed' || (t === 'INPUT' && el.indeterminate) ? 'mixed' : on ? 'checked' : 'not checked');
    }
    if (el.getAttribute('aria-selected') === 'true') out.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') out.push('pressed');
    var ex = el.getAttribute('aria-expanded');
    if (t === 'SUMMARY' && el.parentElement && el.parentElement.tagName === 'DETAILS') ex = el.parentElement.open ? 'true' : 'false';
    if (ex === 'true') out.push('expanded'); else if (ex === 'false') out.push('collapsed');
    if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') out.push('current');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    if (el.readOnly || el.getAttribute('aria-readonly') === 'true') out.push('readonly');
    if (el.required || el.getAttribute('aria-required') === 'true') out.push('required');
    var invalid = el.getAttribute('aria-invalid') === 'true';
    if (!invalid && el.validity) { try { invalid = el.matches(':user-invalid'); } catch (e) {} }
    if (invalid) out.push('invalid');
    return out;
  }

  function valuePart(el, role) {
    var t = el.tagName;
    if (t === 'SELECT') {
      var opts = el.options, sel = [], all = [];
      for (var i = 0; i < opts.length; i++) {
        var lab = clean(opts[i].label || opts[i].text, 40);
        if (opts[i].selected) sel.push(lab);
        if (all.length < 8) all.push(q(lab));
      }
      var more = opts.length > 8 ? ', … (' + opts.length + ' options)' : '';
      return 'value=' + q(sel.join(', ')) + ' options: ' + all.join(', ') + more;
    }
    if (t === 'INPUT' || t === 'TEXTAREA') {
      var type = (el.type || '').toLowerCase();
      if (role === 'checkbox' || role === 'radio' || role === 'button') return '';
      if (type === 'file') return el.files && el.files.length ? 'files=' + el.files.length : '';
      var v = String(el.value || '');
      var head = type && type !== 'text' && type !== 'textarea' && type !== 'search' && type !== 'number' ? 'type=' + type + ' ' : '';
      if (type === 'password') return head + (v ? 'value=(' + v.length + ' chars, hidden)' : 'value=""');
      if (role === 'slider') return 'value=' + q(v) + (el.min !== '' ? ' min=' + el.min : '') + (el.max !== '' ? ' max=' + el.max : '');
      return head + 'value=' + q(clean(v, 120));
    }
    if (el.isContentEditable) return 'value=' + q(clean(el.innerText, 200));
    if (role === 'combobox' || role === 'textbox' || role === 'searchbox' || role === 'slider' || role === 'spinbutton') {
      var av = el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow');
      if (av) return 'value=' + q(clean(av, 80));
    }
    return '';
  }

  function hasInteractive(el) {
    try { return !!(el.querySelector(INTERACTIVE_SEL) || (el.shadowRoot && el.shadowRoot.querySelector(INTERACTIVE_SEL))); } catch (e) { return false; }
  }

  function isAbove(el, inTop) {
    if (!inTop || !el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    return r.bottom < 0 && (r.height > 0 || r.width > 0);
  }

  var ctxTop = true;
  function push(t, el) {
    if (full) return;
    t = '  '.repeat(Math.min(depth, 4)) + prefix + t;
    prefix = '';
    var above = isAbove(el, ctxTop);
    lines.push({ t: t, above: above });
    if (!above) {
      shownChars += t.length + 1;
      if (shownChars > MAX) full = true;
    }
  }
  function flush() {
    if (!buf) return;
    var t = clean(buf, 300);
    var el = bufEl;
    buf = ''; bufEl = null;
    if (t) push(t, el);
  }
  function addText(s, parent) {
    if (!s) return;
    if (/\S/.test(s)) { if (!bufEl) bufEl = parent; buf += s; }
    else if (buf) buf += ' ';
  }

  function walkChildren(node, hiddenText) {
    if (node.tagName === 'SLOT') {
      var assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) { for (var a = 0; a < assigned.length && !full; a++) visit(assigned[a], hiddenText); return; }
    }
    var root = node.shadowRoot || node;
    for (var c = root.firstChild; c && !full; c = c.nextSibling) visit(c, hiddenText);
  }

  function landmark(el) {
    var r = (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    if (r && LANDMARK_ROLE[r]) return r;
    if (r === 'region' && ariaName(el)) return 'region';
    var t = el.tagName;
    if (t === 'DIALOG') return el.open ? 'dialog' : '';
    if (t === 'FORM') return ariaName(el) ? 'form' : '';
    if (LANDMARK_TAG[t]) return LANDMARK_TAG[t];
    if ((t === 'HEADER' || t === 'FOOTER') && !(el.parentElement && el.parentElement.closest('article,aside,main,nav,section'))) return t === 'HEADER' ? 'banner' : 'contentinfo';
    return '';
  }

  function visit(n, hiddenText) {
    if (full) return;
    if (n.nodeType === 3) { if (!hiddenText) addText(n.nodeValue, n.parentElement); return; }
    if (n.nodeType !== 1) return;
    if (++visited > 40000) { full = true; return; }
    var el = n, tag = el.tagName;
    if (SKIP[tag]) return;
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) return;
    var view = el.ownerDocument.defaultView;
    var cs = view.getComputedStyle(el);
    if (cs.display === 'none') return;
    if (cs.display === 'contents') { walkChildren(el, hiddenText); return; }
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') { walkChildren(el, true); return; }
    if (cs.contentVisibility === 'hidden') return;
    var inline = cs.display.indexOf('inline') === 0;

    if (tag === 'BR') { flush(); return; }
    if (tag === 'LABEL' && el.control && el.control.getAttribute('aria-hidden') !== 'true') {
      // Its text is the name of the control: show the control, not the text twice.
      var ctl = el.control;
      if (el.contains(ctl)) { flush(); walkChildren(el, true); flush(); return; }
      var ccs = ctl.ownerDocument.defaultView.getComputedStyle(ctl);
      if (ccs.display !== 'none' && ccs.visibility !== 'hidden') return;
    }

    var role = roleOf(el);
    if (role) {
      var rect = el.getBoundingClientRect();
      var ed = el.isContentEditable && role === 'textbox';
      if (rect.width === 0 && rect.height === 0 && !ed) { if (!inline) flush(); walkChildren(el, hiddenText); return; }
      if (rect.right + view.scrollX <= 0 || rect.bottom + view.scrollY <= 0) return; // pushed off the page (skip links)
      flush();
      var ref = refFor(el);
      var nested = !/^(INPUT|SELECT|TEXTAREA)$/.test(tag) && !el.isContentEditable && hasInteractive(el);
      var head, name;
      if (NAME_INSIDE[role] || el.tagName === 'INPUT' && role !== 'button') {
        name = clean(fieldName(el), 80);
        head = '[' + role + ' ' + ref + (name ? ' ' + q(name) : '') + ']';
      } else {
        name = clean(ownName(el, role), nested ? 60 : 120);
        head = '[' + role + ' ' + ref + ']' + (name ? ' ' + name : '');
      }
      var parts = [head];
      var v = valuePart(el, role);
      if (v) parts.push(v);
      var st = states(el, role);
      if (st.length) parts.push(st.join(' '));
      if (role === 'link') { var h = shortHref(el); if (h && h !== name) parts.push('→ ' + h); }
      push(parts.join(' '), el);
      if (nested) { depth++; walkChildren(el, true); flush(); depth--; }
      return;
    }

    // Text here is already part of a name (or not visible): only controls count.
    if (hiddenText) { walkChildren(el, true); return; }

    if (/^H[1-6]$/.test(tag) || (el.getAttribute('role') || '') === 'heading') {
      flush();
      if (hasInteractive(el)) { prefix += '[heading] '; walkChildren(el, hiddenText); flush(); prefix = ''; return; }
      var ht = clean(visText(el), 200);
      if (ht) push('[heading] ' + ht, el);
      return;
    }

    if (tag === 'IMG') {
      var alt = clean(el.getAttribute('alt'), 100);
      if (alt) { flush(); push('[img ' + q(alt) + ']', el); }
      return;
    }

    if (tag === 'IFRAME' || tag === 'FRAME') {
      var fr = el.getBoundingClientRect();
      if (fr.width < 60 || fr.height < 40) return;
      flush();
      var title = clean(el.getAttribute('title') || el.getAttribute('name') || '', 60);
      var idoc = null;
      try { idoc = el.contentDocument; } catch (e) {}
      if (!idoc || !idoc.body) { push('[iframe' + (title ? ' ' + q(title) : '') + '] (contents not readable)', el); return; }
      var mark = lines.length;
      push('[iframe' + (title ? ' ' + q(title) : '') + ']', el);
      var wasTop = ctxTop; ctxTop = false; depth++;
      walkChildren(idoc.body, false); flush();
      depth--; ctxTop = wasTop;
      if (lines.length === mark + 1) lines.pop();
      return;
    }

    if (tag === 'DETAILS' && !el.open) {
      flush();
      var sm = el.querySelector(':scope > summary');
      if (sm) visit(sm, hiddenText);
      return;
    }

    var lm = landmark(el);
    if (lm) {
      flush();
      var lname = lm === 'alert' || lm === 'status' ? '' : clean(ariaName(el), 60);
      var at = lines.length;
      push('[' + lm + (lname ? ' ' + q(lname) : '') + ']', el);
      depth++;
      walkChildren(el, hiddenText); flush();
      depth--;
      if (lines.length === at + 1) lines.pop(); // empty landmark
      return;
    }

    if (tag === 'LI') { flush(); prefix += '- '; walkChildren(el, hiddenText); flush(); prefix = ''; return; }
    if (tag === 'TR') { flush(); walkChildren(el, hiddenText); flush(); return; }
    if (tag === 'TD' || tag === 'TH') {
      if (buf && !/\|\s*$/.test(buf)) buf += ' | ';
      walkChildren(el, hiddenText);
      return;
    }

    if (!inline) flush();
    walkChildren(el, hiddenText);
    if (!inline) flush();
  }

  if (topDoc.body) { walkChildren(topDoc.body, false); flush(); }
  try { Object.defineProperty(window, '__mlxRefSeq', { value: seq, writable: true, configurable: true, enumerable: false }); } catch (e) {}

  var total = 0;
  for (var i = 0; i < lines.length; i++) total += lines[i].t.length + 1;
  var out = [];
  if (total <= MAX && !full) {
    for (var j = 0; j < lines.length; j++) out.push(lines[j].t);
  } else {
    var aboveN = 0, size = 0, cut = full;
    for (var k = 0; k < lines.length; k++) {
      if (lines[k].above) { aboveN++; continue; }
      if (size + lines[k].t.length + 1 > MAX) { cut = true; break; }
      out.push(lines[k].t); size += lines[k].t.length + 1;
    }
    if (aboveN) out.unshift('…(' + aboveN + ' line' + (aboveN === 1 ? '' : 's') + ' above, scroll up to see them)');
    if (cut) out.push('${MORE_BELOW}');
  }
  var text = out.join('\n');
  if (!text.trim()) text = '(empty page)';
  return { url: String(location.href), title: clean(topDoc.title, 200), text: text };
}
`

/** The snapshot script with a different character cap (tests, small models). */
export function snapshotScript(maxChars: number = SNAPSHOT_MAX_CHARS): string {
  const max = Math.max(500, Math.floor(Number(maxChars) || SNAPSHOT_MAX_CHARS))
  return `(${SNAPSHOT_SRC})(${JSON.stringify(max)})`
}

/** Returns { url, title, text }. */
export const SNAPSHOT_SCRIPT: string = snapshotScript()

function refArg(ref: string): string {
  const r = normalizeRef(ref)
  // An invalid ref still produces a script, one that reports the problem.
  return JSON.stringify(r ?? String(ref))
}

/** Click an element by ref. Returns { ok, error? }. */
export function CLICK_SCRIPT(ref: string): string {
  return String.raw`(function (ref) {
  ${FIND}
  if (!/^e\d+$/.test(ref)) return { ok: false, error: 'Not a ref: ' + JSON.stringify(ref) + '. Use a ref like e12 from the latest snapshot.' };
  var el = __find(document, ref);
  if (!el) return __missing(ref);
  if (__disabled(el)) return { ok: false, error: ref + ' is disabled.' };
  var tag = el.tagName;
  if (tag === 'INPUT' && (el.type || '').toLowerCase() === 'file') return { ok: false, error: 'File uploads are not supported.' };
  if (tag === 'SELECT') return { ok: false, error: ref + ' is a dropdown: use the select action with the option you want.' };
  __into(el);
  var r = el.getBoundingClientRect();
  var x = r.left + r.width / 2, y = r.top + r.height / 2;
  var view = el.ownerDocument.defaultView || window;
  var base = { bubbles: true, cancelable: true, composed: true, view: view, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
  function mouse(type, buttons) {
    var o = Object.assign({}, base, { buttons: buttons });
    try {
      if (type.indexOf('pointer') === 0) el.dispatchEvent(new view.PointerEvent(type, Object.assign(o, { pointerId: 1, pointerType: 'mouse', isPrimary: true })));
      else el.dispatchEvent(new view.MouseEvent(type, o));
    } catch (e) {}
  }
  mouse('pointerover', 0); mouse('mouseover', 0);
  mouse('pointerdown', 1); mouse('mousedown', 1);
  try { if (el.focus) el.focus({ preventScroll: true }); } catch (e) {}
  mouse('pointerup', 0); mouse('mouseup', 0);
  if (typeof el.click === 'function') el.click();
  else el.dispatchEvent(new view.MouseEvent('click', base));
  return { ok: true };
})(${refArg(ref)})`
}

/**
 * Put text into a field by ref (replacing what is there) with the native value
 * setter plus input/change events, so React/Vue/etc. see it. submit = press
 * Enter; when the page doesn't handle Enter itself, the field's form is
 * submitted with requestSubmit(). Returns { ok, error?, submitted?, note? }.
 */
export function TYPE_SCRIPT(ref: string, text: string, submit = false): string {
  return String.raw`(function (ref, text, submit) {
  ${FIND}
  if (!/^e\d+$/.test(ref)) return { ok: false, error: 'Not a ref: ' + JSON.stringify(ref) + '. Use a ref like e12 from the latest snapshot.' };
  var el = __find(document, ref);
  if (!el) return __missing(ref);
  if (__disabled(el)) return { ok: false, error: ref + ' is disabled.' };
  if (!(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
    var inner = el.querySelector && el.querySelector('input:not([type=hidden]),textarea,[contenteditable=""],[contenteditable=true]');
    if (inner) el = inner;
  }
  var tag = el.tagName;
  var doc = el.ownerDocument, view = doc.defaultView || window;
  var note;
  __into(el);
  try { el.focus({ preventScroll: true }); } catch (e) {}
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    var type = (el.type || '').toLowerCase();
    if (tag === 'INPUT' && /^(checkbox|radio|button|submit|reset|image|file|range|color|hidden)$/.test(type)) {
      return { ok: false, error: ref + ' is not a text field (' + type + '). ' + (type === 'checkbox' || type === 'radio' ? 'Use click.' : '') };
    }
    if (el.readOnly) return { ok: false, error: ref + ' is read-only.' };
    var set = __setter(el);
    try { el.dispatchEvent(new view.InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text })); } catch (e) {}
    if (set) set.call(el, text); else el.value = text;
    el.dispatchEvent(new view.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new view.Event('change', { bubbles: true }));
    if (String(el.value) !== text) note = type === 'password' ? 'The field changed what was typed.' : 'The field now holds ' + JSON.stringify(String(el.value).slice(0, 120)) + '.';
  } else if (el.isContentEditable) {
    var sel = view.getSelection();
    var range = doc.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges(); sel.addRange(range);
    var done = false;
    try { done = text ? doc.execCommand('insertText', false, text) : doc.execCommand('delete', false); } catch (e) {}
    if (!done) {
      el.textContent = text;
      el.dispatchEvent(new view.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    }
  } else {
    return { ok: false, error: ref + ' is not a text field.' };
  }
  var submitted = 'none';
  if (submit) {
    function key(type) {
      var ev = new view.KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: type === 'keypress' ? 13 : 0, bubbles: true, cancelable: true, composed: true });
      if (ev.keyCode !== 13) {
        try { Object.defineProperty(ev, 'keyCode', { get: function () { return 13; } }); Object.defineProperty(ev, 'which', { get: function () { return 13; } }); } catch (e) {}
      }
      return !el.dispatchEvent(ev);
    }
    var prevented = key('keydown');
    if (!prevented) prevented = key('keypress');
    key('keyup');
    if (prevented) submitted = 'handled';
    else {
      var form = el.form || (el.closest && el.closest('form'));
      if (form && el.isConnected) {
        try { if (form.requestSubmit) form.requestSubmit(); else form.submit(); submitted = 'form'; }
        catch (e) { note = 'Could not submit the form: ' + (e && e.message || e); }
      }
    }
  }
  var res = { ok: true, submitted: submitted };
  if (note) res.note = note;
  return res;
})(${refArg(ref)}, ${JSON.stringify(String(text ?? ''))}, ${JSON.stringify(!!submit)})`
}

/** Choose an option of a <select> by value or visible label. Returns { ok, error?, label? }. */
export function SELECT_SCRIPT(ref: string, value: string): string {
  return String.raw`(function (ref, value) {
  ${FIND}
  if (!/^e\d+$/.test(ref)) return { ok: false, error: 'Not a ref: ' + JSON.stringify(ref) + '. Use a ref like e12 from the latest snapshot.' };
  var el = __find(document, ref);
  if (!el) return __missing(ref);
  if (__disabled(el)) return { ok: false, error: ref + ' is disabled.' };
  if (el.tagName !== 'SELECT') {
    var inner = el.querySelector && el.querySelector('select');
    if (inner) el = inner;
    else return { ok: false, error: ref + ' is not a native dropdown. Click it to open it, then click the option.' };
  }
  var opts = Array.prototype.slice.call(el.options);
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }
  var want = norm(value);
  var match = opts.filter(function (o) { return o.value === value; })[0]
    || opts.filter(function (o) { return norm(o.label || o.text) === want; })[0]
    || opts.filter(function (o) { return norm(o.value) === want; })[0]
    || (want ? opts.filter(function (o) { return norm(o.label || o.text).indexOf(want) === 0; })[0] : null)
    || (want ? opts.filter(function (o) { return norm(o.label || o.text).indexOf(want) >= 0; })[0] : null);
  if (!match) {
    var list = opts.slice(0, 15).map(function (o) { return JSON.stringify((o.label || o.text).trim()); }).join(', ');
    return { ok: false, error: 'No option ' + JSON.stringify(value) + ' in ' + ref + '. Options: ' + list + (opts.length > 15 ? ', …' : '') };
  }
  if (match.disabled) return { ok: false, error: 'Option ' + JSON.stringify((match.label || match.text).trim()) + ' is disabled.' };
  __into(el);
  try { el.focus({ preventScroll: true }); } catch (e) {}
  var view = el.ownerDocument.defaultView || window;
  if (el.multiple) match.selected = true; else el.selectedIndex = match.index;
  el.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new view.Event('change', { bubbles: true }));
  return { ok: true, label: (match.label || match.text).trim(), value: match.value };
})(${refArg(ref)}, ${JSON.stringify(String(value ?? ''))})`
}

/**
 * Scroll the page (or, when the document itself doesn't scroll, the biggest
 * scrollable area, as in most web apps) by most of a screen, or to the top or
 * bottom. Instant, so the next snapshot sees the new position.
 * Returns { ok, moved, atTop, atBottom }.
 */
export function SCROLL_SCRIPT(direction: ScrollDirection | string = 'down'): string {
  const d = normalizeDirection(direction) ?? 'down'
  return String.raw`(function (dir) {
  var se = document.scrollingElement || document.documentElement;
  var target = null;
  if (se.scrollHeight > innerHeight + 4 && getComputedStyle(document.body || se).overflowY !== 'hidden' && getComputedStyle(se).overflowY !== 'hidden') target = se;
  if (!target) {
    var best = null, bestArea = 0, all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length && i < 20000; i++) {
      var e = all[i];
      if (e.scrollHeight <= e.clientHeight + 4 || e.clientHeight < 60) continue;
      var oy = getComputedStyle(e).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      var r = e.getBoundingClientRect();
      var w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      var h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (w * h > bestArea) { bestArea = w * h; best = e; }
    }
    target = best || se;
  }
  var page = target === se;
  var view = page ? innerHeight : target.clientHeight;
  var before = target.scrollTop;
  var top = dir === 'top' ? 0 : dir === 'bottom' ? target.scrollHeight : before + (dir === 'up' ? -1 : 1) * Math.round(view * 0.85);
  if (page) window.scrollTo({ top: top, behavior: 'instant' });
  else target.scrollTo({ top: top, behavior: 'instant' });
  var after = target.scrollTop;
  return {
    ok: true,
    moved: Math.abs(after - before) >= 1,
    atTop: after <= 1,
    atBottom: after + view >= target.scrollHeight - 2,
  };
})(${JSON.stringify(d)})`
}

export function normalizeDirection(raw: unknown): ScrollDirection | null {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s_-]/g, '')
  if (!s || s === 'down' || s === 'pagedown' || s === 'next' || s === 'more') return 'down'
  if (s === 'up' || s === 'pageup' || s === 'previous' || s === 'back') return 'up'
  if (s === 'top' || s === 'start' || s === 'home') return 'top'
  if (s === 'bottom' || s === 'end') return 'bottom'
  return null
}

/**
 * Resolves once the document has loaded and the DOM has been quiet for
 * quietMs, or after maxMs at the latest. Returns { readyState, quiet }.
 */
export function SETTLE_SCRIPT(quietMs = 300, maxMs = 4000): string {
  return String.raw`(function (quiet, max) {
  var deadline = Date.now() + max;
  function left() { return Math.max(0, deadline - Date.now()); }
  return new Promise(function (resolve) {
    var started = false;
    function quietPhase() {
      if (started) return;
      started = true;
      var timer, hard, obs;
      function done(q) { try { obs.disconnect(); } catch (e) {} clearTimeout(timer); clearTimeout(hard); resolve({ readyState: document.readyState, quiet: q }); }
      try {
        obs = new MutationObserver(function () { clearTimeout(timer); timer = setTimeout(function () { done(true); }, quiet); });
        obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch (e) {}
      timer = setTimeout(function () { done(true); }, Math.min(quiet, left()));
      hard = setTimeout(function () { done(false); }, left());
    }
    if (document.readyState === 'complete') quietPhase();
    else {
      var t = setTimeout(quietPhase, left());
      addEventListener('load', function () { clearTimeout(t); quietPhase(); }, { once: true });
    }
  });
})(${JSON.stringify(Math.max(0, quietMs))}, ${JSON.stringify(Math.max(0, maxMs))})`
}

/**
 * The snapshot line for a ref, without indentation or list/heading prefixes,
 * for approval cards ("Click " + describeTarget(...) → "Click [button e8] Continue").
 * Falls back to "[e8]" when the ref isn't in the snapshot.
 */
export function describeTarget(ref: string, snapshotText: string): string {
  const r = normalizeRef(ref)
  if (!r) return `[${String(ref).slice(0, 20)}]`
  const re = new RegExp(`\\[[a-z]+ ${r}(?=[\\] ])`)
  for (const raw of String(snapshotText ?? '').split('\n')) {
    const m = re.exec(raw)
    if (!m) continue
    const line = raw.slice(m.index).trim()
    return line.length > 160 ? `${line.slice(0, 159)}…` : line
  }
  return `[${r}]`
}
