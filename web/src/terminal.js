// A terminal surface: an xterm.js view onto a server-side pty.
// Size rule: the device you're actually using owns the pty size. Other devices
// render at that size, scaled down to fit if needed.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { IS_MAC } from './icons.js';

export const THEME = {
  background: '#0d1110',
  foreground: '#d7e0da',
  cursor: '#4ade80',
  cursorAccent: '#0d1110',
  selectionBackground: '#2f5a3d',
  black: '#1b2320', red: '#f87171', green: '#4ade80', yellow: '#facc15',
  blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d7e0da',
  brightBlack: '#5b6b63', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047',
  brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
};

export class TermView {
  constructor(app, surface) {
    this.app = app;
    this.id = surface.id;
    this.kind = 'terminal';
    this.server = { cols: surface.cols || 120, rows: surface.rows || 32 };
    this.owner = false;
    this.subscribed = false;
    this.ctrlLatch = false;
    this.altLatch = false;

    this.el = document.createElement('div');
    this.el.className = 'view term-view';
    this.inner = document.createElement('div');
    this.inner.className = 'term-inner';
    this.el.appendChild(this.inner);

    const mobile = app.mobile;
    this.term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Monaco, monospace',
      fontSize: app.fontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      scrollback: 10000,
      theme: THEME,
      cols: this.server.cols,
      rows: this.server.rows,
      smoothScrollDuration: mobile ? 0 : 60,
      minimumContrastRatio: 1,
      rightClickSelectsWord: true,
    });
    this.fit = new FitAddon();
    this.search = new SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new ClipboardAddon());
    const u = new Unicode11Addon();
    this.term.loadAddon(u);
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(new WebLinksAddon((e, uri) => app.openLink(uri, this.id, e)));
    this.term.open(this.inner);
    if (!mobile) {
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        this.term.loadAddon(gl);
      } catch {}
    }
    const ta = this.term.textarea;
    if (ta) {
      for (const [k, v] of Object.entries({ autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false' })) ta.setAttribute(k, v);
    }

    this.term.onData((d) => {
      if (this.ctrlLatch && d.length === 1) {
        const c = d.toUpperCase().charCodeAt(0);
        if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
        this.setCtrl(false);
      }
      if (this.altLatch) { d = '\x1b' + d; this.setAlt(false); }
      this.input(d);
    });
    this.term.onBinary((d) => this.input(d));
    this.term.onTitleChange(() => {});
    this.term.attachCustomKeyEventHandler((e) => this.keyHandler(e));

    this.el.addEventListener('mousedown', () => app.focusSurface(this.id, { claim: true }), true);
    this.el.addEventListener('touchstart', () => app.focusSurface(this.id, { claim: true }), { capture: true, passive: true });
    ta?.addEventListener('focus', () => app.focusSurface(this.id, { claim: true }));
    this.installTouchScroll();
    this.installDrop();

    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.el);
  }

  keyHandler(e) {
    if (e.type !== 'keydown') return true;
    // Shift+Enter: newline in Claude Code and other readline-ish prompts.
    if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey) { this.input('\x1b\r'); return false; }
    if (e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === 'ArrowLeft') { this.input('\x01'); return false; }
      if (e.key === 'ArrowRight') { this.input('\x05'); return false; }
      if (e.key === 'Backspace') { this.input('\x15'); return false; }
      if (e.key === 'k') { this.term.clear(); return false; }
      if (e.key === 'a') { this.term.selectAll(); return false; }
      if (e.key === 'c' && this.term.hasSelection()) return false; // native copy event handles it
      // Leave every other Cmd combo to the app / OS (paste, shortcuts).
      return false;
    }
    if (!IS_MAC && e.ctrlKey && !e.altKey && !e.metaKey) {
      // Windows Terminal conventions: Ctrl+C copies when text is selected,
      // Ctrl+V / Ctrl+Shift+V paste, Ctrl+Shift+C always copies.
      const k = e.code;
      if (k === 'KeyC' && (e.shiftKey || this.term.hasSelection())) {
        if (this.term.hasSelection()) { copyText(this.term.getSelection()); if (!e.shiftKey) this.term.clearSelection(); }
        return false;
      }
      if (k === 'KeyV') return false; // browser fires a paste event that xterm handles
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.key === 'ArrowLeft') { this.input('\x1bb'); return false; }
      if (e.key === 'ArrowRight') { this.input('\x1bf'); return false; }
    }
    return true;
  }

  input(d) {
    this.app.conn.send({ t: 'i', id: this.id, d });
    if (!this.owner) this.claim();
  }

  setCtrl(on) { this.ctrlLatch = on; this.app.onLatch?.(); }
  setAlt(on) { this.altLatch = on; this.app.onLatch?.(); }

  subscribe() {
    if (this.subscribed) return;
    this.subscribed = true;
    this.app.conn.send({ t: 'sub', id: this.id, scrollback: this.app.mobile ? 2000 : 5000 });
  }

  unsubscribe() {
    if (!this.subscribed) return;
    this.subscribed = false;
    this.app.conn.send({ t: 'unsub', id: this.id });
  }

  // Called after a reconnect: the server forgot our subscription.
  resubscribe() {
    this.subscribed = false;
    if (this.visible) this.subscribe();
  }

  onSnap(m) {
    this.server = { cols: m.cols, rows: m.rows };
    this.term.reset();
    this.term.resize(m.cols, m.rows);
    this.term.write(m.data);
    this.layout();
  }

  onOutput(d) { this.term.write(d); }

  onSize(m) {
    this.server = { cols: m.cols, rows: m.rows };
    this.owner = m.by === this.app.clientId;
    this.layout();
  }

  // Make this device's viewport the pty size.
  claim() {
    if (!this.visible) return;
    const d = this.proposed();
    if (!d) return;
    this.owner = true;
    if (d.cols !== this.server.cols || d.rows !== this.server.rows) {
      this.app.conn.send({ t: 'resize', id: this.id, cols: d.cols, rows: d.rows, by: this.app.clientId });
    }
    this.layout();
  }

  proposed() {
    if (!this.el.offsetWidth || !this.el.offsetHeight) return null;
    const core = this.term._core;
    const cell = core?._renderService?.dimensions?.css?.cell;
    if (!cell || !cell.width || !cell.height) {
      const p = this.fit.proposeDimensions();
      return p && p.cols ? { cols: p.cols, rows: p.rows } : null;
    }
    const padX = 8, padY = 4;
    const scrollbar = this.app.mobile ? 0 : 10;
    return {
      cols: Math.max(10, Math.floor((this.el.clientWidth - padX * 2 - scrollbar) / cell.width)),
      rows: Math.max(4, Math.floor((this.el.clientHeight - padY * 2) / cell.height)),
    };
  }

  layout() {
    if (!this.visible) return;
    const d = this.proposed();
    if (!d) return;
    if (this.owner && (d.cols !== this.server.cols || d.rows !== this.server.rows)) {
      clearTimeout(this.claimT);
      this.claimT = setTimeout(() => this.claim(), 60);
    }
    if (this.term.cols !== this.server.cols || this.term.rows !== this.server.rows) {
      this.term.resize(this.server.cols, this.server.rows);
    }
    // Someone else owns the size: scale down to fit, never up.
    const s = Math.min(1, d.cols / this.server.cols, d.rows / this.server.rows);
    this.inner.style.transform = s < 0.999 ? `scale(${s})` : '';
    this.el.classList.toggle('scaled', s < 0.999);
  }

  setVisible(v) {
    const was = this.visible;
    this.visible = v;
    clearTimeout(this.unsubT);
    if (v) {
      this.subscribe();
      if (!was) requestAnimationFrame(() => { this.layout(); this.term.refresh(0, this.term.rows - 1); });
    } else if (was) {
      // Stop streaming tabs nobody is looking at; a snapshot catches us up later.
      this.unsubT = setTimeout(() => this.unsubscribe(), 20000);
    }
  }

  setFontSize(n) {
    this.term.options.fontSize = n;
    if (this.owner) this.claim(); else this.layout();
  }

  focus() { this.term.focus(); }
  blur() { this.term.blur(); }

  find(q, opts = {}) {
    if (!q) { this.search.clearDecorations(); return; }
    return opts.prev ? this.search.findPrevious(q, { decorations: SEARCH_DECOR }) : this.search.findNext(q, { decorations: SEARCH_DECOR, incremental: opts.incremental });
  }

  plainText(maxLines = 400) {
    const b = this.term.buffer.active;
    const out = [];
    for (let i = Math.max(0, b.length - maxLines); i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join('\n');
  }

  installTouchScroll() {
    let y0 = null, acc = 0, moved = false;
    this.el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      y0 = e.touches[0].clientY; acc = 0; moved = false;
    }, { passive: true });
    this.el.addEventListener('touchmove', (e) => {
      if (y0 == null) return;
      const y = e.touches[0].clientY;
      acc += y0 - y;
      y0 = y;
      const lh = this.term._core?._renderService?.dimensions?.css?.cell?.height || 16;
      const lines = Math.trunc(acc / lh);
      if (lines) {
        moved = true;
        acc -= lines * lh;
        if (this.term.buffer.active.type === 'alternate') {
          // Full-screen apps: send arrow keys like a wheel would.
          this.app.conn.send({ t: 'i', id: this.id, d: (lines > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.min(Math.abs(lines), 5)) });
        } else this.term.scrollLines(lines);
      }
      e.preventDefault();
    }, { passive: false });
    this.el.addEventListener('touchend', (e) => {
      if (moved) e.preventDefault();
      y0 = null;
    });
  }

  // Drag files or paste images: upload to the frog host and paste the path,
  // which is how Claude Code takes images and files.
  installDrop() {
    this.el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); this.el.classList.add('drop'); } });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drop'));
    this.el.addEventListener('drop', async (e) => {
      this.el.classList.remove('drop');
      const fl = [...(e.dataTransfer?.files || [])];
      if (!fl.length) return;
      e.preventDefault();
      await this.uploadAndPaste(fl);
    });
    this.term.textarea?.addEventListener('paste', async (e) => {
      const fl = [...(e.clipboardData?.files || [])];
      if (!fl.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      await this.uploadAndPaste(fl);
    }, true);
  }

  async uploadAndPaste(fileList) {
    const paths = [];
    for (const f of fileList) {
      const r = await fetch('/api/upload?name=' + encodeURIComponent(f.name || 'pasted.png'), { method: 'POST', body: f });
      const j = await r.json();
      if (j.path) paths.push(j.path.includes(' ') ? `"${j.path}"` : j.path);
    }
    if (paths.length) this.app.conn.op('paste', { id: this.id, text: paths.join(' ') + ' ' });
    this.focus();
  }

  dispose() {
    this.unsubscribe();
    this.ro.disconnect();
    this.term.dispose();
    this.el.remove();
  }
}

const SEARCH_DECOR = {
  matchBackground: '#3b4b1f', matchBorder: '#facc15', matchOverviewRuler: '#facc15',
  activeMatchBackground: '#715c0a', activeMatchBorder: '#fde047', activeMatchColorOverviewRuler: '#fde047',
};

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).catch(() => fallbackCopy(text)); return; }
  fallbackCopy(text);
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch {}
  ta.remove();
}
