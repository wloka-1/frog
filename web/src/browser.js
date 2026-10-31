// A browser surface: an iframe pointed at the frog proxy for the target origin.
// The proxy injects picker.js, which reports navigation and picked elements.
import { icon } from './icons.js';

export function normalizeUrl(input) {
  let s = (input || '').trim();
  if (!s) return '';
  if (/^\d{2,5}(\/.*)?$/.test(s)) return 'http://localhost:' + s;
  if (/^:\d+/.test(s)) return 'http://localhost' + s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/.test(s)) return 'http://' + s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return 'https://' + s;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}

export class BrowserView {
  constructor(app, surface) {
    this.app = app;
    this.id = surface.id;
    this.kind = 'browser';
    this.url = '';
    this.picking = false;

    this.el = document.createElement('div');
    this.el.className = 'view browser-view';
    this.el.innerHTML = `
      <div class="bar">
        <button class="ib back" title="Back">${icon('back')}</button>
        <button class="ib fwd" title="Forward">${icon('fwd')}</button>
        <button class="ib reload" title="Reload (⌘R)">${icon('reload')}</button>
        <form class="urlform"><input class="url" spellcheck="false" autocapitalize="off" autocorrect="off" placeholder="localhost:3000 or a URL" /></form>
        <button class="ib pick" title="Select an element and send it to the terminal (⌘⇧C)">${icon('pick')}<span class="pick-label">Select</span></button>
        <button class="ib ext" title="Open in system browser">${icon('external')}</button>
      </div>
      <div class="frame-wrap"><div class="start"></div><iframe allow="clipboard-read; clipboard-write; fullscreen; geolocation; camera; microphone" referrerpolicy="no-referrer-when-downgrade"></iframe><div class="pick-hint">Click an element to send it to the terminal · ⇧click to add more · ↑ parent · Esc to cancel</div></div>`;
    this.frame = this.el.querySelector('iframe');
    this.input = this.el.querySelector('.url');
    this.start = this.el.querySelector('.start');
    this.pickBtn = this.el.querySelector('.pick');

    this.el.querySelector('.urlform').addEventListener('submit', (e) => {
      e.preventDefault();
      this.navigate(normalizeUrl(this.input.value));
      this.input.blur();
    });
    this.input.addEventListener('focus', () => { app.focusSurface(this.id); this.input.select(); });
    this.el.querySelector('.back').onclick = () => this.cmd('back');
    this.el.querySelector('.fwd').onclick = () => this.cmd('forward');
    this.el.querySelector('.reload').onclick = () => this.reload();
    this.el.querySelector('.ext').onclick = () => this.url && window.open(this.url, '_blank');
    this.pickBtn.onclick = () => this.togglePick();
    this.el.addEventListener('mousedown', () => app.focusSurface(this.id), true);
    this.el.addEventListener('touchstart', () => app.focusSurface(this.id), { capture: true, passive: true });
    this.frame.addEventListener('focus', () => app.focusSurface(this.id));

    this.onMsg = (e) => {
      if (e.source !== this.frame.contentWindow || !e.data?.frog) return;
      const m = e.data;
      if (m.type === 'loc') {
        if (m.url !== this.url) {
          this.url = m.url;
          this.input.value = m.url;
          app.conn.op('surface.update', { id: this.id, url: m.url, title: m.title || undefined });
        } else if (m.title && m.title !== this.title) {
          app.conn.op('surface.update', { id: this.id, title: m.title });
        }
        this.title = m.title;
        if (this.picking) this.post({ frogCmd: 'pick', on: true });
      }
      if (m.type === 'pick-state') this.setPicking(m.on, false);
      if (m.type === 'picked') app.sendPicked(this.id, m.items);
      if (m.type === 'pick-count') app.toast(`${m.n} element${m.n > 1 ? 's' : ''} selected — click one more to send`);
      if (m.type === 'key') app.handleForwardedKey(m);
    };
    addEventListener('message', this.onMsg);
    this.sync(surface);
  }

  // State from the server (another device may have navigated).
  sync(surface) {
    const url = surface.url || '';
    if (url && url !== this.url) this.navigate(url, { fromServer: true });
    if (!url) this.showStart();
  }

  showStart() {
    this.el.classList.add('empty');
    const ports = this.app.portsForWorkspace(this.app.stateOf(this.id)?.ws);
    this.start.innerHTML = `<div class="start-inner"><div class="start-title">Open a page</div>
      ${ports.length ? `<div class="start-sub">Running in this workspace</div><div class="chips">${ports.map((p) => `<button class="chip" data-url="http://localhost:${p}">localhost:${p}</button>`).join('')}</div>` : '<div class="start-sub">Type a port like <b>3000</b> or a URL above.</div>'}
      <div class="start-sub">Then hit <b>${icon('pick')} Select</b> to point at an element and send it to Claude.</div></div>`;
    this.start.querySelectorAll('.chip').forEach((b) => (b.onclick = () => this.navigate(b.dataset.url)));
    if (this.visible && !this.app.mobile) setTimeout(() => this.input.focus(), 50);
  }

  async navigate(url, { fromServer } = {}) {
    if (!url) return;
    this.el.classList.remove('empty');
    this.url = url;
    this.input.value = url;
    try {
      const u = new URL(url);
      const { port } = await this.app.conn.op('proxy', { url });
      this.frame.src = `${location.protocol}//${location.hostname}:${port}${u.pathname}${u.search}${u.hash}`;
      if (!fromServer) this.app.conn.op('surface.update', { id: this.id, url });
    } catch (e) {
      this.app.toast('Could not open ' + url + ': ' + e.message);
    }
  }

  post(m) { try { this.frame.contentWindow?.postMessage(m, '*'); } catch {} }
  cmd(c) { this.post({ frogCmd: c }); }
  reload() { if (this.frame.src) { try { this.cmd('reload'); } catch { this.frame.src = this.frame.src; } } }

  togglePick() { this.setPicking(!this.picking, true); }
  setPicking(on, tell) {
    this.picking = on;
    this.pickBtn.classList.toggle('on', on);
    this.el.classList.toggle('picking', on);
    if (tell) {
      this.post({ frogCmd: 'pick', on });
      if (on) this.frame.focus();
    }
  }

  setVisible(v) { this.visible = v; }
  focus() { if (!this.url) this.input.focus(); else this.frame.focus(); }
  blur() {}
  focusUrl() { this.input.focus(); this.input.select(); }
  dispose() { removeEventListener('message', this.onMsg); this.el.remove(); }
}
