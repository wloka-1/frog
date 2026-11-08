// One Term = one shell on a pty, mirrored into a headless xterm so any client
// (desktop or phone) can join mid-session and get the exact screen + scrollback.
import pty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import path from 'node:path';
import { isWin, shellArgs } from './platform.js';

const { Terminal } = headless;
const { SerializeAddon } = serialize;

// Modes a full-screen program turns on and must turn off when it exits. If it
// dies without cleaning up (e.g. an ssh session drops), the shell inherits them
// and every mouse move types escape-code garbage at the prompt.
const STICKY_RESET = '\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l'
  + '\x1b[?1015l\x1b[?1016l\x1b[?1004l\x1b[?2026l\x1b[?25h';

export class Term {
  constructor({ id, cwd, cols = 120, rows = 32, env, shell, scrollback = 10000, restore, events }) {
    this.id = id;
    this.cols = cols;
    this.rows = rows;
    this.events = events; // { bell, notify, title, cwd, exit }
    this.subs = new Set(); // { send(msg), pending, queue }
    this.pendingOut = '';
    this.flushTimer = null;
    this.oscCwd = null;
    this.lastOutputAt = 0;
    this.burstStart = 0;
    this.idleNotifiedFor = 0;

    this.head = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.ser = new SerializeAddon();
    this.head.loadAddon(this.ser);
    this.head.onBell(() => this.events.bell?.());
    this.head.onTitleChange((t) => this.events.title?.(t));
    const p = this.head.parser;
    // OSC 9 (iTerm2/Claude Code style). "9;4;..." is ConEmu progress, not a notification.
    p.registerOscHandler(9, (d) => {
      if (/^4;/.test(d)) return true;
      if (/^9;/.test(d)) { this.setCwd(d.slice(2).replace(/^"|"$/g, '')); return true; } // Windows Terminal cwd
      this.events.notify?.({ body: d });
      return true;
    });
    // OSC 777;notify;title;body (urxvt / Ghostty)
    p.registerOscHandler(777, (d) => {
      const [kind, title, ...rest] = d.split(';');
      if (kind === 'notify') this.events.notify?.({ title, body: rest.join(';') });
      return true;
    });
    // OSC 99 (kitty) - payload after the last ';'
    p.registerOscHandler(99, (d) => { this.events.notify?.({ body: d.slice(d.indexOf(';') + 1) }); return true; });
    // OSC 7 cwd reporting
    p.registerOscHandler(7, (d) => {
      try {
        let p = decodeURIComponent(new URL(d).pathname);
        if (isWin && /^\/[A-Za-z]:/.test(p)) p = p.slice(1).replace(/\//g, '\\');
        this.setCwd(p);
      } catch {}
      return true;
    });

    if (restore) this.head.write(restore);

    this.shellName = path.basename(shell).replace(/\.exe$/i, '');
    this.stickyTimer = null;
    this.pty = pty.spawn(shell, shellArgs(shell), { name: 'xterm-256color', cols, rows, cwd, env });
    this.pid = this.pty.pid;
    this.pty.onData((d) => this.onData(d));
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.flush();
      this.events.exit?.(exitCode);
    });
  }

  setCwd(p) {
    if (!p || p === this.oscCwd) return;
    this.oscCwd = p;
    this.events.cwd?.(p);
  }

  onData(d) {
    if (this.disposed) return;
    const now = Date.now();
    // A "burst" is output with no gap over 1.5s; long bursts mean a program is working.
    if (now - this.lastOutputAt > 1500) this.burstStart = now;
    this.lastOutputAt = now;
    this.emit(d);
    // Once output stops, check whether the shell is back in front with modes left on.
    // node-pty only knows the foreground process on Unix; Windows relies on resetStickyModes() from the live poll.
    if (!isWin && !this.stickyTimer) this.stickyTimer = setTimeout(() => this.checkSticky(), 200);
  }

  emit(d) {
    this.head.write(d);
    this.pendingOut += d;
    // Coalesce bursts into one frame per ~5ms.
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 5);
  }

  hasStickyModes() {
    const m = this.head.modes;
    return m.mouseTrackingMode !== 'none' || m.sendFocusMode || m.synchronizedOutputMode;
  }

  checkSticky() {
    this.stickyTimer = null;
    if (this.disposed || !this.hasStickyModes()) return;
    let fg;
    try { fg = this.pty.process; } catch { return; }
    if (fg && fg.replace(/^-/, '') === this.shellName) this.resetStickyModes();
  }

  // Turn off modes left behind by a program that is no longer running.
  resetStickyModes() {
    if (this.disposed || !this.hasStickyModes()) return;
    this.emit(STICKY_RESET);
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.pendingOut) return;
    const d = this.pendingOut;
    this.pendingOut = '';
    for (const s of this.subs) {
      if (s.pending) s.queue.push(d);
      else s.send({ t: 'o', id: this.id, d });
    }
  }

  // Attach a client: it gets a snapshot, then the live stream with no gaps or dupes.
  // The empty write is a marker in the parser queue: everything before it is in
  // the snapshot, everything after it is queued for this subscriber.
  subscribe(send, { scrollback } = {}) {
    this.flush();
    const sub = { send, pending: true, queue: [] };
    this.subs.add(sub);
    this.head.write('', () => {
      const data = this.ser.serialize({ scrollback: scrollback ?? 5000 });
      send({ t: 'snap', id: this.id, data, cols: this.cols, rows: this.rows });
      sub.pending = false;
      for (const d of sub.queue) send({ t: 'o', id: this.id, d });
      sub.queue = [];
    });
    return () => this.subs.delete(sub);
  }

  write(d) {
    if (!this.exited) this.pty.write(d);
  }

  paste(text) {
    const t = text.replace(/\r?\n/g, '\r');
    this.write(this.head.modes.bracketedPasteMode ? `\x1b[200~${t}\x1b[201~` : t);
  }

  resize(cols, rows) {
    cols = Math.max(10, Math.min(500, cols | 0));
    rows = Math.max(4, Math.min(300, rows | 0));
    if (cols === this.cols && rows === this.rows) return false;
    this.cols = cols;
    this.rows = rows;
    try { this.pty.resize(cols, rows); } catch {}
    this.head.resize(cols, rows);
    return true;
  }

  snapshotForRestore() {
    try { return this.ser.serialize({ scrollback: 2000, excludeAltBuffer: true, excludeModes: true }); } catch { return ''; }
  }

  kill() {
    if (this.disposed) return;
    this.disposed = true;
    this.exited = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.stickyTimer);
    try { isWin ? this.pty.kill() : this.pty.kill('SIGHUP'); } catch {}
    if (!isWin) setTimeout(() => { try { process.kill(this.pid, 'SIGKILL'); } catch {} }, 1500);
    this.head.dispose();
  }
}

// Turn a saved screen into something safe to replay before a fresh shell:
// cursor parked under the last line of old output, plus a divider.
export function prepareRestore(saved, cols = 120, rows = 32) {
  if (!saved) return Promise.resolve('');
  const t = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
  return new Promise((resolve) => {
    t.write(saved, () => {
      const b = t.buffer.active;
      let last = b.length - 1;
      while (last > 0 && !b.getLine(last)?.translateToString(true).trim()) last--;
      const row = last - b.viewportY; // 0-based row in the viewport
      t.dispose();
      let out = saved + '\x1b[0m';
      out += row >= rows - 1 ? '\r\n' : `\x1b[${row + 2};1H`;
      out += '\x1b[2m── frog restarted · new shell ──\x1b[0m\r\n';
      resolve(out);
    });
  });
}
