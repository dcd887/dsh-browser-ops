import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir, homedir, platform } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'

/**
 * Browser Ops 7 — a self-managed persistent browser for automation.
 *
 * What changed from earlier versions:
 *  - web_launch starts (or reuses) its OWN Chrome/Edge with a persistent
 *    profile directory, so login state survives restarts and it never touches
 *    the window the user is working in.
 *  - web_navigate / web_tabs let it open and switch pages instead of
 *    being stuck on whatever tab is focused.
 *  - every page-scoped tool takes `page` (URL substring) to pick the target.
 *
 * Deliberately NOT implemented: bypassing login walls, CAPTCHAs, or human
 * verification. A person logs in once in the managed browser; the session
 * cookie persists; automation continues afterwards.
 */

const DEFAULT_PORT = 9222
const DEFAULT_PROFILE = join(tmpdir(), 'dsh-browser-profile')

const CONFIG = {
  port: DEFAULT_PORT,
  profileDir: DEFAULT_PROFILE,
  browserPath: '',
  urlIncludes: '',
  screenshotDir: '',
}

/* ---------------- HTTP helpers (no fetch: keep it independent) ---------------- */

function httpJson(host, port, path, method = 'GET', timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path, method, timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} ${path}`))
          return
        }
        try { resolve(body ? JSON.parse(body) : null) } catch (e) { resolve(body) }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`timeout ${path}`)))
    req.on('error', (e) => reject(new Error(`${e.code || e.name}: ${e.message} (${host}:${port})`)))
    req.end()
  })
}

async function cdpAlive(port) {
  try {
    const v = await httpJson('127.0.0.1', port, '/json/version', 'GET', 3000)
    return v && v.webSocketDebuggerUrl ? v : null
  } catch { return null }
}

function findBrowser() {
  if (CONFIG.browserPath && existsSync(CONFIG.browserPath)) return CONFIG.browserPath
  const candidates = platform() === 'win32'
    ? [
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      ]
    : platform() === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge']
  for (const c of candidates) if (existsSync(c)) return c
  return ''
}

/* ---------------- CDP ---------------- */

class CDP {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (!msg.id) {
        const hs = this.listeners.get(msg.method)
        if (hs) for (const h of hs) { try { h(msg.params) } catch (_) {} }
        return
      }
      const e = this.pending.get(msg.id)
      if (!e) return
      this.pending.delete(msg.id)
      if (msg.error) e.reject(new Error(`${msg.error.message || 'CDP error'} (${msg.error.code ?? '?'})`))
      else e.resolve(msg.result)
    })
    ws.addEventListener('close', () => {
      this.closed = true
      for (const [, e] of this.pending) e.reject(new Error('CDP socket closed'))
      this.pending.clear()
    })
  }

  static async attach(wsUrl) {
    if (typeof WebSocket === 'undefined') throw new Error('global WebSocket unavailable; Node 22+ required')
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP connect timed out')), 8000)
      ws.addEventListener('open', () => { clearTimeout(t); resolve() })
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP socket error')) })
    })
    return new CDP(ws)
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(fn)
    return () => { try { this.listeners.get(method).delete(fn) } catch (_) {} }
  }

  send(method, params = {}, timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new Error('CDP socket closed'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)) }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v) },
        reject: (e) => { clearTimeout(t); reject(e) },
      })
      try { this.ws.send(JSON.stringify({ id, method, params })) }
      catch (e) { clearTimeout(t); this.pending.delete(id); reject(e) }
    })
  }

  async ev(expression, timeoutMs) {
    const r = await this.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: true },
      timeoutMs || 20000)
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(`page exception: ${d.text || d.exception?.description || 'unknown'}`)
    }
    return r.result ? r.result.value : undefined
  }

  close() { try { this.ws.close() } catch {} }
}

async function pages(port) {
  const list = await httpJson('127.0.0.1', port, '/json/list')
  return (list || []).filter((t) => t && t.type === 'page' && typeof t.url === 'string')
}

function pickPage(list, pattern) {
  if (pattern) {
    const hit = list.find((t) => t.url.includes(pattern))
    if (hit) return hit
  }
  const http = list.find((t) => /^https?:\/\//.test(t.url))
  return http || list[0] || null
}

async function withPage(args, fn) {
  const port = CONFIG.port || DEFAULT_PORT
  if (!(await cdpAlive(port))) {
    throw new Error(`no browser on port ${port}. Call web_launch first.`)
  }
  const list = await pages(port)
  const pattern = args.page || CONFIG.urlIncludes || ''
  const target = pickPage(list, pattern)
  if (!target || !target.webSocketDebuggerUrl) {
    throw new Error(`no matching page (open tabs: ${list.map((t) => t.url).join(' | ') || 'none'})`)
  }
  const cdp = await CDP.attach(target.webSocketDebuggerUrl)
  try { return await fn(cdp, target) } finally { cdp.close() }
}

/* ---------------- input ---------------- */

async function mouseAt(cdp, type, x, y, extra = {}) {
  await cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1, ...extra,
  })
}

async function clickAt(cdp, x, y, double) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  await new Promise((r) => setTimeout(r, 60))
  await mouseAt(cdp, 'mousePressed', x, y)
  await new Promise((r) => setTimeout(r, 90))
  await mouseAt(cdp, 'mouseReleased', x, y)
  if (double) {
    await new Promise((r) => setTimeout(r, 160))
    await mouseAt(cdp, 'mousePressed', x, y, { clickCount: 2 })
    await new Promise((r) => setTimeout(r, 90))
    await mouseAt(cdp, 'mouseReleased', x, y, { clickCount: 2 })
  }
}

const KEYMAP = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}

async function pressKey(cdp, name) {
  const k = KEYMAP[name] || { key: name, code: name, keyCode: 0 }
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode }
  if (k.text) await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: k.text, unmodifiedText: k.text, ...base })
  else await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/* ---------------- snapshot / act ---------------- */

const SNAPSHOT_FN = `((opts) => {
  const MAX_ELEMS = opts.maxElements || 160;
  const MAX_TEXT = opts.maxText || 1000;
  const store = (window.__dshRefs = window.__dshRefs || {});
  for (const k of Object.keys(store)) delete store[k];
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };
  const nameOf = (el) => {
    const tag = el.tagName, type = (el.getAttribute('type') || '').toLowerCase();
    let lab = '';
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) lab = clean(l.innerText); }
    if (!lab) { const w = el.closest('label'); if (w) lab = clean(w.innerText); }
    const c = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), lab,
      el.getAttribute('title'), el.getAttribute('alt'),
      tag === 'INPUT' && ['button','submit','reset'].includes(type) ? el.value : '',
      (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') ? '' : el.innerText,
      el.getAttribute('name'), el.id];
    for (const x of c) { const t = clean(x); if (t) return t.slice(0, 70); }
    return '';
  };
  const roleOf = (el) => {
    if (el.getAttribute('role')) return el.getAttribute('role');
    const t = el.tagName, ty = (el.getAttribute('type') || '').toLowerCase();
    if (t === 'A') return 'link';
    if (t === 'BUTTON') return 'button';
    if (t === 'SELECT') return 'select';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'INPUT') return ty === 'checkbox' ? 'checkbox' : ty === 'radio' ? 'radio' : (ty === 'submit' || ty === 'button') ? 'button' : 'textbox';
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  };
  const SEL = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role],[onclick],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
  let nodes = [];
  try { nodes = [...document.querySelectorAll(SEL)] } catch (e) { nodes = [] }
  const items = [], seen = new Set();
  for (const el of nodes) {
    if (seen.has(el)) continue; seen.add(el);
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    const ref = 'e' + (items.length + 1);
    store[ref] = el;
    const rec = { ref, role: roleOf(el), name: nameOf(el), tag: el.tagName,
      inView: r.top < innerHeight && r.bottom > 0 };
    if (el.disabled) rec.disabled = true;
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value) rec.value = String(el.value).slice(0, 40);
    if (el.tagName === 'SELECT' && el.selectedIndex >= 0) rec.value = clean(el.options[el.selectedIndex].text);
    if (el.type === 'checkbox' || el.type === 'radio') rec.checked = !!el.checked;
    items.push(rec);
    if (items.length >= MAX_ELEMS) break;
  }
  const body = clean(document.body ? document.body.innerText : '').slice(0, MAX_TEXT);
  const lines = ['URL: ' + location.href, 'TITLE: ' + document.title,
    'VIEWPORT: ' + innerWidth + 'x' + innerHeight + '  SCROLL: ' + Math.round(scrollY) + '/' + Math.round(document.documentElement.scrollHeight),
    'ELEMENTS: ' + items.length + (items.length >= MAX_ELEMS ? '+' : '')];
  for (const it of items) {
    let s = '[' + it.ref + '] ' + it.role;
    if (it.name) s += ' "' + it.name + '"';
    if (it.value) s += ' value="' + it.value + '"';
    if (it.checked !== undefined) s += it.checked ? ' checked' : ' unchecked';
    if (it.disabled) s += ' DISABLED';
    if (!it.inView) s += ' offscreen';
    lines.push(s);
  }
  if (body) { lines.push('--- TEXT ---'); lines.push(body) }
  return lines.join('\\n');
})`

const FIND_BY = `(p) => {
  const store = window.__dshRefs || {};
  if (p.ref) { const el = store[p.ref]; return el ? { el, how: 'ref' } : { error: 'ref ' + p.ref + ' is stale; take a new snapshot' } }
  if (p.selector) { const el = document.querySelector(p.selector); return el ? { el, how: 'selector' } : { error: 'selector not found' } }
  if (p.text) {
    const want = (p.text || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const SEL = 'a[href],button,input,select,textarea,summary,[role],[onclick],[contenteditable="true"],[tabindex]';
    const cands = [...document.querySelectorAll(SEL)].filter((e) => e.offsetParent !== null);
    const nm = (el) => {
      const c = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'),
        el.tagName === 'INPUT' ? (['button','submit','reset'].includes((el.type||'').toLowerCase()) ? el.value : '') : el.innerText];
      for (const x of c) { const t = (x || '').replace(/\\s+/g, ' ').trim(); if (t) return t }
      return '';
    };
    const hit = cands.find((e) => nm(e).toLowerCase() === want) || cands.find((e) => nm(e).toLowerCase().includes(want));
    return hit ? { el: hit, how: 'text', name: nm(hit) } : { error: 'no element matching text: ' + p.text };
  }
  return { error: 'need ref, text or selector' };
}`

/* ---------------- network idle / dom stability ---------------- */

async function waitNetworkIdle(cdp, { idleMs = 800, timeoutMs = 12000, needDomStable = true } = {}) {
  const inflight = new Set()
  let lastMutation = Date.now()
  const off1 = cdp.on('Network.requestWillBeSent', (e) => {
    if (e && e.requestId) inflight.add(e.requestId)
    lastMutation = Date.now()
  })
  const off2 = cdp.on('Network.loadingFinished', (e) => {
    if (e && e.requestId) inflight.delete(e.requestId)
    lastMutation = Date.now()
  })
  const off3 = cdp.on('Network.loadingFailed', (e) => {
    if (e && e.requestId) inflight.delete(e.requestId)
    lastMutation = Date.now()
  })
  let off4 = () => {}
  try {
    await cdp.send('Network.enable', {}, 8000)
    if (needDomStable) {
      await cdp.send('DOM.enable', {}, 8000)
      off4 = cdp.on('DOM.documentUpdated', () => { lastMutation = Date.now() })
    }
  } catch (_) {}

  const start = Date.now()
  let quietSince = 0
  try {
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 120))
      const now = Date.now()
      const quiet = inflight.size === 0 && now - lastMutation >= idleMs
      if (quiet) {
        if (!quietSince) quietSince = now
        if (now - quietSince >= idleMs) {
          return { ok: true, waitedMs: now - start, inflight: 0 }
        }
      } else {
        quietSince = 0
      }
    }
    return { ok: false, waitedMs: Date.now() - start, inflight: inflight.size, timeoutMs }
  } finally {
    off1(); off2(); off3(); off4()
  }
}

async function domSignature(cdp) {
  return await cdp.ev('(() => ({ n: document.querySelectorAll("*").length, h: document.documentElement.scrollHeight, t: (document.body ? document.body.innerText.length : 0) }))()')
}

/* ---------------- tools ---------------- */

const PAGE = { page: { type: 'string', description: 'URL substring of the target tab; omit for the last-used or first http tab.' } }

const TOOLS = [
  {
    name: 'web_launch',
    description:
      'Start (or reuse) the plugin\'s OWN browser: a dedicated Chrome/Edge process with a persistent profile directory, remote debugging port, and its own window. It is independent of whatever browser you are using, keeps cookies and logins across restarts, and closing it only closes that instance. Call this once per session; subsequent calls report the running instance.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional page to open after launch.' },
        headless: { type: 'boolean', description: 'Run without a visible window (default false).' },
        port: { type: 'number', description: 'Debugging port (default 9222).' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const port = args.port || CONFIG.port || DEFAULT_PORT
      // 让后续所有工具跟随本次启动的端口，避免启动在 A 端口、工具却连 B 端口
      CONFIG.port = port
      const alive = await cdpAlive(port)
      if (alive) return { reused: true, port, browser: alive.Browser, profileDir: CONFIG.profileDir }
      const bin = findBrowser()
      if (!bin) throw new Error('no Chrome/Edge found; set config.browserPath')
      const profileDir = CONFIG.profileDir
      try { mkdirSync(profileDir, { recursive: true }) } catch {}
      const argv = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--window-size=1500,950',
      ]
      if (args.headless) argv.push('--headless=new')
      if (args.url) argv.push(args.url)
      const child = spawn(bin, argv, { detached: true, stdio: 'ignore' })
      child.unref()
      let info = null
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500))
        info = await cdpAlive(port)
        if (info) break
      }
      if (!info) throw new Error('browser started but the debugging port never answered')
      return { launched: true, port, browser: info.Browser, bin, profileDir }
    },
  },
  {
    name: 'web_status',
    description: 'Report whether the managed browser is running, its version, profile directory, and the list of open tabs.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const port = CONFIG.port || DEFAULT_PORT
      const v = await cdpAlive(port)
      if (!v) return { running: false, port, profileDir: CONFIG.profileDir }
      const list = await pages(port)
      return { running: true, port, browser: v.Browser, profileDir: CONFIG.profileDir,
               tabs: list.map((t, i) => ({ index: i, title: t.title, url: t.url })) }
    },
  },
  {
    name: 'web_tabs',
    description: 'List open tabs, open a new one, close one by index or URL, or activate one. Use it to keep one tab per task instead of piling up windows.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'close', 'activate'], description: 'Default list.' },
        url: { type: 'string', description: 'For new: URL to open. For close/activate: match substring.' },
        index: { type: 'number', description: 'For close/activate: tab index from list.' },
        all: { type: 'boolean', description: 'For close: close every tab (honour keep).' },
        keep: { type: 'array', items: { type: 'number' }, description: 'For close with all: tab indexes to keep.' },
        indexes: { type: 'array', items: { type: 'number' }, description: 'For close: close these tab indexes.' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const port = CONFIG.port || DEFAULT_PORT
      if (!(await cdpAlive(port))) throw new Error(`no browser on port ${port}; call web_launch`)
      const action = args.action || 'list'
      let list = await pages(port)
      if (action === 'list') return { tabs: list.map((t, i) => ({ index: i, title: t.title, url: t.url })) }
      if (action === 'new') {
        const u = args.url || 'about:blank'
        await httpJson('127.0.0.1', port, `/json/new?${encodeURIComponent(u)}`, 'PUT')
        await new Promise((r) => setTimeout(r, 1200))
        list = await pages(port)
        const t = list.find((x) => x.url.includes(u.replace(/^https?:\/\//, '').slice(0, 30))) || list[list.length - 1]
        CONFIG.urlIncludes = t ? t.url.slice(0, 40) : CONFIG.urlIncludes
        return { opened: t ? t.url : u, tabs: list.length }
      }
      const target = typeof args.index === 'number' ? list[args.index] : list.find((t) => args.url && t.url.includes(args.url))
      if (!target) throw new Error('tab not found')
      if (action === 'close') {
        // 批量模式：all / indexes；单页模式沿用 index 或 url
        let victims = []
        if (args.all) {
          const keep = new Set(Array.isArray(args.keep) ? args.keep : [])
          victims = list.filter((_t, i) => !keep.has(i))
        } else if (Array.isArray(args.indexes) && args.indexes.length) {
          victims = args.indexes.map((i) => list[i]).filter(Boolean)
        } else {
          victims = [target]
        }
        const closed = []
        for (const v of victims) {
          await httpJson('127.0.0.1', port, `/json/close/${v.id}`, 'GET').catch(() => {})
          closed.push(v.url)
          await new Promise((r) => setTimeout(r, 250))
        }
        await new Promise((r) => setTimeout(r, 500))
        const remain = await pages(port)
        return { closed, count: closed.length, remaining: remain.length }
      }
      if (action === 'activate') {
        await httpJson('127.0.0.1', port, `/json/activate/${target.id}`, 'GET').catch(() => {})
        CONFIG.urlIncludes = target.url.slice(0, 40)
        return { active: target.url }
      }
      throw new Error('unknown action')
    },
  },
  {
    name: 'web_navigate',
    description:
      'Navigate a tab to a URL. With newTab=true it opens a fresh tab instead of replacing the current page. Use this to go to a site; then take a snapshot to see what is there.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL.' },
        newTab: { type: 'boolean', description: 'Open in a new tab (default false).' },
        waitMs: { type: 'number', description: 'Settle time after load (default 2000).' },
        page: PAGE.page,
      },
      required: ['url'],
      additionalProperties: false,
    },
    async run(args) {
      const port = CONFIG.port || DEFAULT_PORT
      if (!(await cdpAlive(port))) throw new Error(`no browser on port ${port}; call web_launch`)
      if (args.newTab) {
        await httpJson('127.0.0.1', port, `/json/new?${encodeURIComponent(args.url)}`, 'PUT')
        await new Promise((r) => setTimeout(r, args.waitMs || 2000))
        const list = await pages(port)
        const t = list.find((x) => x.url.includes(args.url.slice(0, 30))) || list[list.length - 1]
        return { url: t ? t.url : args.url, newTab: true }
      }
      return await withPage(args, async (cdp) => {
        const result = { ok: true, url: args.url }
        try {
          await cdp.send('Page.enable', {}, 15000)
        } catch (e) {
          return { ok: false, stage: 'enable', error: e.message, url: args.url,
                   hint: 'page may still be usable; call web_snapshot to check' }
        }
        try {
          // 导航本身超时不代表失败：网页常常在 load 事件前就可用了
          await cdp.send('Page.navigate', { url: args.url }, args.timeoutMs || 25000)
        } catch (e) {
          result.ok = false
          result.stage = 'navigate'
          result.error = e.message
          result.hint = 'navigation did not confirm in time; the page may still have loaded'
        }
        await new Promise((r) => setTimeout(r, args.waitMs ?? 2000))
        try {
          const info = await cdp.ev('({ url: location.href, title: document.title, ready: document.readyState })', 10000)
          Object.assign(result, info)
          if (info && info.url && !String(info.url).startsWith('chrome-error')) result.ok = result.ok !== false ? true : result.ok
        } catch (e) {
          result.state = 'unreadable: ' + e.message
        }
        if (args.idle !== false) {
          try { result.idle = await waitNetworkIdle(cdp, { idleMs: args.idleMs || 800, timeoutMs: args.idleTimeoutMs || 12000 }) } catch (e) { result.idle = { ok: false, error: e.message } }
        }
        return result
      })
    },
  },
  {
    name: 'web_snapshot',
    description:
      'Read the page as a compact semantic outline: every visible interactive element gets a ref like [e12] with its role, accessible name, value and state. Act on those refs afterwards. Refs are invalidated by each new snapshot, so take a fresh one after any navigation or DOM change.',
    parameters: {
      type: 'object',
      properties: {
        maxElements: { type: 'number', description: 'Max elements (default 160).' },
        maxText: { type: 'number', description: 'Max body text chars (default 1000).' },
        page: PAGE.page,
      },
      additionalProperties: false,
    },
    async run(args) {
      return await withPage(args, async (cdp) => {
        const out = await cdp.ev(`(${SNAPSHOT_FN})(${JSON.stringify({ maxElements: args.maxElements, maxText: args.maxText })})`, 30000)
        return { snapshot: out }
      })
    },
  },
  {
    name: 'web_act',
    description:
      'Perform one action by ref (from the latest snapshot), visible text, or CSS selector. Actions: click, dblclick, type, select, hover, focus, check/uncheck, submit. Typing focuses for real, inserts text, then reads the value back and falls back to a framework-safe setter if needed.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        text: { type: 'string' },
        selector: { type: 'string' },
        action: {
          type: 'string',
          enum: ['click', 'dblclick', 'type', 'select', 'hover', 'focus', 'check', 'uncheck', 'submit'],
          description: 'Default click.',
        },
        value: { type: 'string', description: 'For type/select.' },
        clear: { type: 'boolean', description: 'Clear before typing (default true).' },
        pressEnter: { type: 'boolean', description: 'Press Enter after typing.' },
        page: PAGE.page,
      },
      additionalProperties: false,
    },
    async run(args) {
      const action = args.action || 'click'
      return await withPage(args, async (cdp) => {
        const res = await cdp.ev(`(() => {
          const find = ${FIND_BY};
          const r = find(${JSON.stringify({ ref: args.ref, selector: args.selector, text: args.text })});
          if (r.error) return r;
          window.__dshTarget = r.el;
          r.el.scrollIntoView({ block: 'center', inline: 'center' });
          const q = r.el.getBoundingClientRect();
          return { how: r.how, name: r.name || '', x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) };
        })()`)
        if (res.error) throw new Error(res.error)

        if (action === 'hover') {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: res.x, y: res.y, buttons: 0 })
          return { action, ...res }
        }
        if (action === 'focus') {
          await cdp.ev('(() => { const e = window.__dshTarget; if (e && e.focus) e.focus(); return true })()')
          return { action, ...res }
        }
        if (action === 'click' || action === 'dblclick') {
          await clickAt(cdp, res.x, res.y, action === 'dblclick')
          return { action, ...res }
        }
        if (action === 'type') {
          await clickAt(cdp, res.x, res.y, false)
          await new Promise((r) => setTimeout(r, 120))
          if (args.clear !== false) {
            await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
            await pressKey(cdp, 'Backspace')
          }
          if (args.value) { try { await cdp.send('Input.insertText', { text: String(args.value) }) } catch {} }
          let st = await cdp.ev('(() => { const e = window.__dshTarget; return e ? String(e.value ?? "") : null })()')
          if (st !== String(args.value ?? '')) {
            await cdp.ev(`(() => {
              const e = window.__dshTarget;
              const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const d = Object.getOwnPropertyDescriptor(proto, 'value');
              try { d.set.call(e, ${JSON.stringify(String(args.value ?? ''))}); } catch (_) { e.value = ${JSON.stringify(String(args.value ?? ''))}; }
              e.dispatchEvent(new Event('input', { bubbles: true }));
              e.dispatchEvent(new Event('change', { bubbles: true }));
              return e.value;
            })()`)
            st = await cdp.ev('(() => { const e = window.__dshTarget; return e ? String(e.value ?? "") : null })()')
          }
          if (args.pressEnter) await pressKey(cdp, 'Enter')
          return { action, ...res, value: st }
        }
        if (action === 'select') {
          const r = await cdp.ev(`(() => {
            const e = window.__dshTarget;
            const want = ${JSON.stringify(String(args.value ?? ''))};
            const opts = [...e.options];
            const hit = opts.find((o) => o.value === want) || opts.find((o) => (o.text || '').trim() === want) || opts.find((o) => (o.text || '').includes(want));
            if (!hit) return { error: 'no option matching ' + want, options: opts.slice(0, 10).map((o) => o.text.trim()) };
            e.value = hit.value;
            e.dispatchEvent(new Event('change', { bubbles: true }));
            return { value: hit.value, text: (hit.text || '').trim() };
          })()`)
          if (r.error) throw new Error(r.error + (r.options ? ' | ' + r.options.join(' / ') : ''))
          return { action, ...res, ...r }
        }
        if (action === 'check' || action === 'uncheck') {
          const want = action === 'check'
          const cur = await cdp.ev('(() => !!window.__dshTarget.checked)()')
          if (cur !== want) await clickAt(cdp, res.x, res.y, false)
          const after = await cdp.ev('(() => !!window.__dshTarget.checked)()')
          return { action, ...res, checked: after }
        }
        if (action === 'submit') {
          await cdp.ev(`(() => {
            const e = window.__dshTarget;
            const f = e && (e.form || e.closest('form'));
            if (f && f.requestSubmit) { f.requestSubmit(); return 'form' }
            if (f) { f.submit(); return 'form' }
            if (e) { e.click(); return 'click' }
            return 'none';
          })()`)
          return { action, ...res }
        }
        throw new Error('unknown action: ' + action)
      })
    },
  },
  {
    name: 'web_key',
    description: 'Press a key on the focused element: Enter, Tab, Escape, Backspace, Delete, arrows, Space.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        times: { type: 'number', description: 'Repeat count (default 1).' },
        page: PAGE.page,
      },
      required: ['key'],
      additionalProperties: false,
    },
    async run(args) {
      return await withPage(args, async (cdp) => {
        const n = args.times || 1
        for (let i = 0; i < n; i++) { await pressKey(cdp, args.key); await new Promise((r) => setTimeout(r, 120)) }
        return { key: args.key, times: n }
      })
    },
  },
  {
    name: 'web_scroll',
    description: 'Scroll the page: direction up/down with an amount, or to="top"/"bottom".',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Default down.' },
        amount: { type: 'number', description: 'Pixels (default 600).' },
        page: PAGE.page,
      },
      additionalProperties: false,
    },
    async run(args) {
      return await withPage(args, async (cdp) => {
        const dir = args.direction || 'down'
        const amt = args.amount || 600
        if (dir === 'top') await cdp.ev('window.scrollTo(0,0)')
        else if (dir === 'bottom') await cdp.ev('window.scrollTo(0, document.documentElement.scrollHeight)')
        else await cdp.ev(`window.scrollBy(0, ${dir === 'up' ? -amt : amt})`)
        await new Promise((r) => setTimeout(r, 400))
        return await cdp.ev('({ y: Math.round(scrollY), height: Math.round(document.documentElement.scrollHeight) })')
      })
    },
  },
  {
    name: 'web_shot',
    description: 'Capture the page to an image file and return its path. Use it when the snapshot is not enough: canvas, charts, layout, or visual confirmation.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Default png.' },
        quality: { type: 'number', description: 'JPEG quality (default 75).' },
        path: { type: 'string', description: 'Absolute output path.' },
        fullPage: { type: 'boolean', description: 'Capture beyond the viewport.' },
        page: PAGE.page,
      },
      additionalProperties: false,
    },
    async run(args) {
      return await withPage(args, async (cdp) => {
        await cdp.send('Page.enable')
        const fmt = args.format || 'png'
        const params = fmt === 'jpeg' ? { format: 'jpeg', quality: args.quality || 75 } : { format: 'png' }
        if (args.fullPage) params.captureBeyondViewport = true
        const shot = await cdp.send('Page.captureScreenshot', params, 30000)
        const dir = CONFIG.screenshotDir || tmpdir()
        try { mkdirSync(dir, { recursive: true }) } catch {}
        const file = args.path || join(dir, `shot-${Date.now()}.${fmt === 'jpeg' ? 'jpg' : 'png'}`)
        const buf = Buffer.from(shot.data, 'base64')
        writeFileSync(file, buf)
        return { path: file, format: fmt, bytes: buf.length }
      })
    },
  },
  {
    name: 'web_eval',
    description: 'Evaluate JavaScript in the page and return the value. Use for reads the snapshot does not cover and site-specific tricks.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string' },
        timeoutMs: { type: 'number' },
        page: PAGE.page,
      },
      required: ['expression'],
      additionalProperties: false,
    },
    async run(args) {
      return await withPage(args, async (cdp) => {
        const v = await cdp.ev(args.expression, args.timeoutMs)
        return { result: v === undefined ? null : v }
      })
    },
  },
  {
    name: 'web_wait',
    description:
      'Wait for the page to reach a condition, and optionally for the network to go quiet. Conditions: a selector becoming visible, some text appearing, the URL containing a string. networkIdle=true also waits until no request is in flight for idleMs and the DOM signature stops changing — that is the reliable way to wait for lazy-loaded or infinite-scroll lists instead of guessing a sleep.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Wait until this selector is visible.' },
        text: { type: 'string', description: 'Wait until this text appears in the body.' },
        urlIncludes: { type: 'string', description: 'Wait until the URL contains this.' },
        networkIdle: { type: 'boolean', description: 'Also wait for network quiet plus a stable DOM (default false).' },
        idleMs: { type: 'number', description: 'Quiet period for networkIdle (default 800).' },
        stableDom: { type: 'boolean', description: 'Require an unchanged DOM signature for idleMs (default true).' },
        timeoutMs: { type: 'number', description: 'Deadline (default 30000).' },
        intervalMs: { type: 'number', description: 'Poll interval (default 700).' },
        page: PAGE.page,
      },
      additionalProperties: false,
    },
    async run(args) {
      const deadline = Date.now() + (args.timeoutMs || 30000)
      const iv = args.intervalMs || 700
      const expr = `(() => {
        const p = ${JSON.stringify({ selector: args.selector, text: args.text, urlIncludes: args.urlIncludes })};
        if (p.selector) { const e = document.querySelector(p.selector); return (e && e.offsetParent !== null) ? { ok: true, why: 'visible' } : { ok: false, why: e ? 'hidden' : 'absent' } }
        if (p.urlIncludes) return location.href.includes(p.urlIncludes) ? { ok: true, why: 'url' } : { ok: false, why: location.href }
        if (p.text) { const t = (document.body ? document.body.innerText : '').replace(/\s+/g, ' '); return t.includes(p.text) ? { ok: true, why: 'text' } : { ok: false, why: 'absent' } }
        return { ok: true, why: 'no condition given' };
      })()`
      return await withPage(args, async (cdp) => {
        const start = Date.now()
        let cond = null
        const hasCond = !!(args.selector || args.text || args.urlIncludes)
        while (true) {
          cond = await cdp.ev(expr)
          if (cond && cond.ok) break
          if (Date.now() >= deadline) break
          await new Promise((r) => setTimeout(r, iv))
        }

        let idle = null
        if (args.networkIdle) {
          const remain = Math.max(1000, deadline - Date.now())
          idle = await waitNetworkIdle(cdp, {
            idleMs: args.idleMs || 800,
            timeoutMs: Math.min(remain, 20000),
            needDomStable: args.stableDom !== false,
          })
        }

        const condOk = hasCond ? !!(cond && cond.ok) : true
        const idleOk = args.networkIdle ? !!(idle && idle.ok) : true
        return {
          ok: condOk && idleOk,
          waitedMs: Date.now() - start,
          condition: hasCond ? cond : null,
          networkIdle: idle,
        }
      })
    },
  },
  {
    name: 'web_click',
    description: 'Raw coordinate click for canvas or game UIs that expose no semantics. Prefer web_act for ordinary pages.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        mode: { type: 'string', enum: ['single', 'double'], description: 'Default single.' },
        page: PAGE.page,
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    async run(args) {
      return await withPage(args, async (cdp) => {
        await clickAt(cdp, args.x, args.y, (args.mode || 'single') === 'double')
        return { clicked: { x: args.x, y: args.y, mode: args.mode || 'single' } }
      })
    },
  },
  {
    name: 'web_drag',
    description: 'Raw drag for drag-and-drop UIs: press, interpolated moves, hold, release. Raise steps and holdMs when a short drag is ignored.',
    parameters: {
      type: 'object',
      properties: {
        fromX: { type: 'number' }, fromY: { type: 'number' },
        toX: { type: 'number' }, toY: { type: 'number' },
        steps: { type: 'number', description: 'Default 20.' },
        stepMs: { type: 'number', description: 'Default 40.' },
        holdMs: { type: 'number', description: 'Default 260.' },
        page: PAGE.page,
      },
      required: ['fromX', 'fromY', 'toX', 'toY'],
      additionalProperties: false,
    },
    async run(args) {
      return await withPage(args, async (cdp) => {
        const { fromX, fromY, toX, toY } = args
        const steps = args.steps || 20, stepMs = args.stepMs || 40, holdMs = args.holdMs || 260
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY, buttons: 0 })
        await new Promise((r) => setTimeout(r, 120))
        await mouseAt(cdp, 'mousePressed', fromX, fromY)
        await new Promise((r) => setTimeout(r, 220))
        for (let i = 1; i <= steps; i++) {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: fromX + ((toX - fromX) * i) / steps,
            y: fromY + ((toY - fromY) * i) / steps,
            button: 'left', buttons: 1,
          })
          await new Promise((r) => setTimeout(r, stepMs))
        }
        await new Promise((r) => setTimeout(r, holdMs))
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0 })
        return { dragged: { from: [fromX, fromY], to: [toX, toY] } }
      })
    },
  },
  {
    name: 'web_upload',
    description:
      'Set files on an <input type="file"> element by CSS selector, bypassing the OS file dialog entirely. This is the reliable way to upload files. It cannot drive browser-native directory pickers such as showDirectoryPicker: those must be chosen by a person once.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the file input (default input[type=file]).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths.' },
        page: PAGE.page,
      },
      required: ['files'],
      additionalProperties: false,
    },
    async run(args) {
      return await withPage(args, async (cdp) => {
        const sel = args.selector || 'input[type=file]'
        await cdp.send('DOM.enable', {}, 8000)
        const doc = await cdp.send('DOM.getDocument', { depth: 1 })
        const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel })
        if (!node || !node.nodeId) throw new Error(`no file input matching ${sel}`)
        await cdp.send('DOM.setFileInputFiles', { files: args.files, nodeId: node.nodeId })
        const v = await cdp.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? { count: e.files ? e.files.length : 0, names: e.files ? [...e.files].map(f => f.name) : [] } : null })()`)
        return { uploaded: v, selector: sel }
      })
    },
  },
]

export const name = 'browser-ops8'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  Object.assign(CONFIG, config)

  for (const tool of TOOLS) {
    ctx.effect(() =>
      ctx.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: {
          schema: { type: 'object', description: 'Tool-specific JSON result.' },
          render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2).slice(0, 14000) }],
        },
        async execute(args) {
          const v = await tool.run(args || {})
          if (v === undefined || v === null) return { result: null }
          if (typeof v !== 'object') return { result: v }
          return v
        },
      }),
    )
  }
}
