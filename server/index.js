// frog server: owns shells, layout and browser proxies; every client (desktop
// app, phone) is a view onto the same state, so you can start on one device and
// pick up on another.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Term, prepareRestore } from './terms.js';
import { createAuth, isLoopback, normalizeIp } from './auth.js';
import { createProxyManager } from './proxy.js';
import * as files from './files.js';
import * as platform from './platform.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.FROG_HOME || path.join(os.homedir(), '.frog');
fs.mkdirSync(path.join(DATA, 'scrollback'), { recursive: true });

const config = {
  port: 7777,
  host: '0.0.0.0',
  allowedLogins: [],
  allowLan: false,
  proxyBasePort: 7801,
  scrollback: 10000,
  ...readJSON(path.join(DATA, 'config.json'), {}),
};
if (process.env.FROG_PORT) config.port = +process.env.FROG_PORT;

const SHELL = platform.defaultShell();
const WEB = path.join(ROOT, 'web', 'dist');
const auth = createAuth({ config, dataDir: DATA });
const proxies = createProxyManager({ host: config.host, basePort: config.proxyBasePort, auth, staticDir: path.join(ROOT, 'server', 'static') });

function readJSON(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
const uid = (p) => p + crypto.randomBytes(4).toString('hex');
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- state
// workspaces: [{ id, name, customName, cwd, layout, focusPane }]
// layout: { type:'pane', id, surfaces:[id], active } | { type:'split', id, dir:'row'|'col', ratio, children:[a,b] }
// surfaces: { [id]: { id, ws, kind:'terminal'|'browser'|'editor', title, cwd, url, file, unread, notif } }
let state = readJSON(path.join(DATA, 'state.json'), null) || { workspaces: [], surfaces: {}, lastActive: null };
const terms = new Map(); // surfaceId -> Term
const live = {}; // surfaceId -> { cwd, proc, ports, git }
const clients = new Set();

function saveState() {
  clearTimeout(saveState.t);
  saveState.t = setTimeout(() => {
    const s = JSON.stringify(state);
    fs.writeFileSync(path.join(DATA, 'state.json.tmp'), s);
    fs.renameSync(path.join(DATA, 'state.json.tmp'), path.join(DATA, 'state.json'));
  }, 300);
}

function publicState() {
  return { ...state, live, host: os.hostname(), home: os.homedir() };
}

function pushState() {
  saveState();
  clearTimeout(pushState.t);
  pushState.t = setTimeout(() => broadcast({ t: 'state', state: publicState() }), 10);
}

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) c.raw(s);
}

function findNode(node, pred, parent = null) {
  if (pred(node)) return { node, parent };
  if (node.type === 'split') {
    for (const ch of node.children) {
      const r = findNode(ch, pred, node);
      if (r) return r;
    }
  }
  return null;
}
const panesOf = (node, out = []) => {
  if (node.type === 'pane') out.push(node);
  else node.children.forEach((c) => panesOf(c, out));
  return out;
};
const wsById = (id) => state.workspaces.find((w) => w.id === id);
const paneOf = (ws, surfaceId) => panesOf(ws.layout).find((p) => p.surfaces.includes(surfaceId));
function locate(surfaceId) {
  const s = state.surfaces[surfaceId];
  if (!s) return null;
  const ws = wsById(s.ws);
  return ws ? { s, ws, pane: paneOf(ws, surfaceId) } : null;
}

// The cwd a new terminal in this workspace should start in: the focused terminal's.
function currentCwd(ws, paneId) {
  const pane = (paneId && panesOf(ws.layout).find((p) => p.id === paneId)) || panesOf(ws.layout).find((p) => p.id === ws.focusPane);
  const candidates = [pane?.active, ...(pane?.surfaces || []), ...Object.keys(state.surfaces).filter((k) => state.surfaces[k].ws === ws.id)];
  for (const id of candidates) {
    if (id && state.surfaces[id]?.kind === 'terminal' && live[id]?.cwd) return live[id].cwd;
  }
  return ws.cwd;
}

function makeSurface(ws, kind, opts = {}) {
  const id = uid('s');
  const s = { id, ws: ws.id, kind, title: kind, unread: false, notif: null };
  if (kind === 'terminal') {
    s.cwd = files.expand(opts.cwd || currentCwd(ws, opts.pane));
    s.title = path.basename(s.cwd) || '~';
  }
  if (kind === 'browser') { s.url = opts.url || ''; s.title = opts.url ? hostOf(opts.url) : 'New tab'; }
  if (kind === 'editor') { s.file = opts.file || ''; s.line = opts.line || 0; s.root = opts.root || currentCwd(ws, opts.pane); s.title = s.file ? path.basename(s.file) : 'Editor'; }
  state.surfaces[id] = s;
  if (kind === 'terminal') spawnTerm(s);
  return s;
}

function hostOf(u) { try { return new URL(u).host; } catch { return u; } }

function newWorkspace(opts = {}) {
  const cwd = files.expand(opts.cwd || os.homedir());
  const ws = { id: uid('w'), name: opts.name || path.basename(cwd) || 'home', customName: !!opts.name, cwd, layout: null, focusPane: null };
  const pane = { type: 'pane', id: uid('p'), surfaces: [], active: null };
  ws.layout = pane;
  ws.focusPane = pane.id;
  const idx = opts.after ? state.workspaces.findIndex((w) => w.id === opts.after) + 1 : state.workspaces.length;
  state.workspaces.splice(idx || state.workspaces.length, 0, ws);
  const s = makeSurface(ws, opts.kind || 'terminal', { cwd, url: opts.url });
  pane.surfaces.push(s.id);
  pane.active = s.id;
  return ws;
}

function spawnTerm(s, restore) {
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'frog',
    TERM_PROGRAM_VERSION: '0.1.0',
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_CTYPE: process.env.LC_CTYPE || 'en_US.UTF-8',
    FROG_SURFACE_ID: s.id,
    FROG_WORKSPACE_ID: s.ws,
    FROG_PORT: String(config.port),
    PATH: [path.join(ROOT, 'bin'), process.env.PATH || process.env.Path || ''].join(path.delimiter),
  };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'XPC_SERVICE_NAME', 'XPC_FLAGS']) delete env[k];
  // Windows env keys are case-insensitive; keep exactly one PATH.
  for (const k of Object.keys(env)) if (k !== 'PATH' && k.toUpperCase() === 'PATH') delete env[k];
  let cwd = s.cwd;
  if (!fs.existsSync(cwd)) cwd = os.homedir();
  const t = new Term({
    id: s.id, cwd, env, shell: SHELL, scrollback: config.scrollback, restore,
    cols: s.cols || 120, rows: s.rows || 32,
    events: {
      bell: () => notify(s.id, { body: 'Bell', source: 'bell' }),
      notify: (n) => notify(s.id, { ...n, source: 'osc' }),
      title: (title) => { if (state.surfaces[s.id]) { state.surfaces[s.id].termTitle = title; pushState(); } },
      cwd: (c) => { live[s.id] = { ...live[s.id], cwd: c }; },
      exit: () => {
        terms.delete(s.id);
        if (shuttingDown) return;
        if (state.surfaces[s.id]) closeSurface(s.id);
        pushState();
      },
    },
  });
  terms.set(s.id, t);
  live[s.id] = { cwd };
}

function closeSurface(id) {
  const loc = locate(id);
  const t = terms.get(id);
  if (t) { terms.delete(id); t.kill(); }
  delete state.surfaces[id];
  delete live[id];
  try { fs.unlinkSync(path.join(DATA, 'scrollback', id + '.txt')); } catch {}
  if (!loc) return;
  const { ws, pane } = loc;
  if (!pane) return;
  const i = pane.surfaces.indexOf(id);
  pane.surfaces.splice(i, 1);
  if (pane.active === id) pane.active = pane.surfaces[Math.min(i, pane.surfaces.length - 1)] || null;
  if (!pane.surfaces.length) closePane(ws, pane.id);
}

function closePane(ws, paneId) {
  const hit = findNode(ws.layout, (n) => n.id === paneId);
  if (!hit) return;
  for (const sid of [...hit.node.surfaces]) {
    if (state.surfaces[sid]) {
      const t = terms.get(sid);
      if (t) { terms.delete(sid); t.kill(); }
      delete state.surfaces[sid];
      delete live[sid];
    }
  }
  if (!hit.parent) {
    // Last pane in the workspace: the workspace goes too.
    closeWorkspace(ws.id);
    return;
  }
  const sibling = hit.parent.children.find((c) => c !== hit.node);
  const grand = findNode(ws.layout, (n) => n.type === 'split' && n.children.includes(hit.parent));
  if (grand) grand.node.children[grand.node.children.indexOf(hit.parent)] = sibling;
  else ws.layout = sibling;
  if (ws.focusPane === paneId) ws.focusPane = panesOf(sibling)[0].id;
}

function closeWorkspace(id) {
  const ws = wsById(id);
  if (!ws) return;
  for (const p of panesOf(ws.layout)) {
    for (const sid of p.surfaces) {
      const t = terms.get(sid);
      if (t) { terms.delete(sid); t.kill(); }
      delete state.surfaces[sid];
      delete live[sid];
    }
  }
  state.workspaces = state.workspaces.filter((w) => w.id !== id);
  if (!state.workspaces.length) newWorkspace();
}

function notify(id, { title, body, source }) {
  const s = state.surfaces[id];
  if (!s) return;
  const now = Date.now();
  // An OSC notification usually comes with a bell; keep the richer one.
  if (source === 'bell' && s.notif && now - s.notif.ts < 3000) return;
  // Someone is typing in this exact terminal right now: a bell is just noise.
  const watching = [...clients].some((c) => c.focus === id && c.visible && now - c.inputAt < 8000);
  if (watching && source === 'bell') return;
  const ws = wsById(s.ws);
  s.unread = !watching;
  s.notif = { title: title || ws?.name || s.title, body: (body || '').slice(0, 300), ts: now };
  broadcast({ t: 'notify', id, ws: s.ws, title: s.notif.title, body: s.notif.body, quiet: watching });
  pushState();
}

// ---------------------------------------------------------------- live info (cwd, ports, running program, git)
const isOwnPort = (port) => port === config.port || (port >= config.proxyBasePort && port < config.proxyBasePort + 100);
let liveBusy = false;

async function refreshLive() {
  if (liveBusy) return;
  liveBusy = true;
  try { await refreshLiveInner(); } finally { liveBusy = false; }
}

async function refreshLiveInner() {
  const pids = [...terms.values()].filter((t) => !t.exited).map((t) => t.pid);
  if (!pids.length) return;
  const { cwdByPid, parent, procs, portsByPid } = await platform.snapshot(pids, isOwnPort);
  const shellOf = {};
  for (const t of terms.values()) shellOf[t.pid] = t.id;
  // Which terminal a process belongs to, and how many levels below its shell.
  const ancestorShell = (pid) => {
    for (let depth = 0; depth < 40 && pid > 1; depth++) {
      if (shellOf[pid]) return { sid: shellOf[pid], depth };
      pid = parent[pid];
    }
    return null;
  };
  const portsBySurface = {}, fgBySurface = {};
  for (const [pid, ports] of Object.entries(portsByPid)) {
    const a = ancestorShell(+pid);
    if (a) for (const p of ports) (portsBySurface[a.sid] ||= new Set()).add(p);
  }
  for (const [pid, info] of Object.entries(procs)) {
    if (!info.fg || shellOf[pid]) continue;
    const a = ancestorShell(+pid);
    if (!a) continue;
    // The program closest to the shell is the one the user ran (e.g. "claude", not its node child).
    const prev = fgBySurface[a.sid];
    if (!prev || a.depth < prev.depth) fgBySurface[a.sid] = { depth: a.depth, comm: info.comm };
  }
  let changed = false;
  for (const t of terms.values()) {
    const cwd = cwdByPid[t.pid] || t.oscCwd || live[t.id]?.cwd;
    const g = cwd ? files.gitBranch(cwd) : null;
    const next = {
      cwd,
      proc: fgBySurface[t.id]?.comm || null,
      ports: [...(portsBySurface[t.id] || [])].sort((a, b) => a - b),
      git: g ? g.branch : null,
      gitRoot: g ? g.root : null,
    };
    // A program just ended and the shell is in front again: drop modes it left on.
    if (live[t.id]?.proc && !next.proc) t.resetStickyModes();
    if (JSON.stringify(next) !== JSON.stringify(live[t.id])) { live[t.id] = next; changed = true; }
    // Fallback attention signal for AI agents without hooks: it worked for a
    // while, then went quiet. Hooks/OSC notifications win when present.
    const proc = next.proc || '';
    const now = Date.now();
    if (/claude|codex|aider|gemini|opencode/i.test(proc) && t.burstStart && t.lastOutputAt - t.burstStart > 6000
        && now - t.lastOutputAt > 4000 && t.idleNotifiedFor !== t.burstStart) {
      t.idleNotifiedFor = t.burstStart;
      const sur = state.surfaces[t.id];
      if (!sur?.notif || now - sur.notif.ts > 15000) {
        notify(t.id, { title: `${proc} · ${path.basename(cwd || '')}`, body: 'Finished — waiting for you', source: 'idle' });
      }
    }
    const s = state.surfaces[t.id];
    if (s && cwd && s.cwd !== cwd) { s.cwd = cwd; s.title = path.basename(cwd) || '/'; changed = true; }
  }
  for (const ws of state.workspaces) {
    if (ws.customName) continue;
    const c = currentCwd(ws);
    const g = c && files.gitBranch(c);
    const name = path.basename(g?.root || c || '') || '~';
    if (ws.name !== name) { ws.name = name; changed = true; }
  }
  if (changed) pushState();
}
setInterval(refreshLive, platform.liveInterval);

// ---------------------------------------------------------------- ops (all mutations go through here)
const ops = {
  'ws.new': (a) => { const ws = newWorkspace(a); return { ws: ws.id }; },
  'ws.rename': ({ id, name }) => { const ws = wsById(id); if (ws) { ws.name = name || ws.name; ws.customName = !!name; } },
  'ws.close': ({ id }) => closeWorkspace(id),
  'ws.move': ({ id, to }) => {
    const i = state.workspaces.findIndex((w) => w.id === id);
    if (i < 0) return;
    const [w] = state.workspaces.splice(i, 1);
    state.workspaces.splice(Math.max(0, Math.min(to, state.workspaces.length)), 0, w);
  },
  'surface.new': ({ ws: wsId, pane: paneId, kind, url, file, cwd, line }) => {
    const ws = wsById(wsId);
    if (!ws) return;
    const pane = panesOf(ws.layout).find((p) => p.id === paneId) || panesOf(ws.layout).find((p) => p.id === ws.focusPane) || panesOf(ws.layout)[0];
    const s = makeSurface(ws, kind || 'terminal', { url, file, cwd, line, pane: pane.id });
    const at = pane.active ? pane.surfaces.indexOf(pane.active) + 1 : pane.surfaces.length;
    pane.surfaces.splice(at, 0, s.id);
    pane.active = s.id;
    ws.focusPane = pane.id;
    return { surface: s.id, pane: pane.id };
  },
  'surface.close': ({ id }) => closeSurface(id),
  'surface.activate': ({ id }) => {
    const loc = locate(id);
    if (!loc?.pane) return;
    loc.pane.active = id;
    loc.ws.focusPane = loc.pane.id;
  },
  'surface.update': ({ id, url, file, title, line }) => {
    const s = state.surfaces[id];
    if (!s) return;
    if (url !== undefined) { s.url = url; s.title = title || hostOf(url); }
    if (file !== undefined) { s.file = file; s.title = path.basename(file); }
    if (line !== undefined) s.line = line;
    if (title && url === undefined && file === undefined) s.title = title;
  },
  'surface.move': ({ id, pane: toPaneId, index }) => {
    const loc = locate(id);
    if (!loc?.pane) return;
    const to = panesOf(loc.ws.layout).find((p) => p.id === toPaneId);
    if (!to) return;
    const from = loc.pane;
    from.surfaces.splice(from.surfaces.indexOf(id), 1);
    to.surfaces.splice(index ?? to.surfaces.length, 0, id);
    to.active = id;
    loc.ws.focusPane = to.id;
    if (from.active === id) from.active = from.surfaces[0] || null;
    if (!from.surfaces.length && from !== to) closePane(loc.ws, from.id);
  },
  'surface.toWorkspace': ({ id, ws: wsId }) => {
    const loc = locate(id);
    const dest = wsById(wsId);
    if (!loc?.pane || !dest || dest === loc.ws) return;
    loc.pane.surfaces.splice(loc.pane.surfaces.indexOf(id), 1);
    if (loc.pane.active === id) loc.pane.active = loc.pane.surfaces[0] || null;
    const empty = !loc.pane.surfaces.length;
    const target = panesOf(dest.layout).find((p) => p.id === dest.focusPane) || panesOf(dest.layout)[0];
    target.surfaces.push(id);
    target.active = id;
    loc.s.ws = dest.id;
    if (empty) closePane(loc.ws, loc.pane.id);
  },
  'pane.split': ({ ws: wsId, pane: paneId, dir, kind, url, file, surface: moveId }) => {
    const ws = wsById(wsId);
    if (!ws) return;
    const hit = findNode(ws.layout, (n) => n.id === paneId);
    if (!hit) return;
    const pane = { type: 'pane', id: uid('p'), surfaces: [], active: null };
    let sid;
    if (moveId && hit.node.surfaces.includes(moveId) && hit.node.surfaces.length > 1) {
      // Split by dragging a tab out: move that surface into the new pane.
      hit.node.surfaces.splice(hit.node.surfaces.indexOf(moveId), 1);
      if (hit.node.active === moveId) hit.node.active = hit.node.surfaces[0];
      sid = moveId;
    } else {
      sid = makeSurface(ws, kind || 'terminal', { url, file, pane: paneId }).id;
    }
    pane.surfaces.push(sid);
    pane.active = sid;
    const before = dir === 'left' || dir === 'up';
    const split = { type: 'split', id: uid('x'), dir: dir === 'down' || dir === 'up' ? 'col' : 'row', ratio: 0.5, children: before ? [pane, hit.node] : [hit.node, pane] };
    if (hit.parent) hit.parent.children[hit.parent.children.indexOf(hit.node)] = split;
    else ws.layout = split;
    ws.focusPane = pane.id;
    return { pane: pane.id, surface: sid };
  },
  'pane.close': ({ ws: wsId, pane }) => { const ws = wsById(wsId); if (ws) closePane(ws, pane); },
  'pane.ratio': ({ ws: wsId, split, ratio }) => {
    const ws = wsById(wsId);
    const hit = ws && findNode(ws.layout, (n) => n.id === split);
    if (hit) hit.node.ratio = Math.max(0.08, Math.min(0.92, +ratio));
  },
  'pane.focus': ({ ws: wsId, pane }) => { const ws = wsById(wsId); if (ws) ws.focusPane = pane; },
  'notif.clear': ({ id }) => { const s = state.surfaces[id]; if (s) s.unread = false; },
  'notif.clearAll': () => { for (const s of Object.values(state.surfaces)) s.unread = false; },
  paste: ({ id, text }) => { terms.get(id)?.paste(text); },
  input: ({ id, data }) => { terms.get(id)?.write(data); },
  proxy: async ({ url }) => ({ port: await proxies.ensure(url) }),
  'pair.code': () => ({ code: auth.newCode() }),
};

async function runOp(msg, client) {
  const fn = ops[msg.op];
  if (!fn) throw new Error('unknown op ' + msg.op);
  const result = await fn(msg.args || {}, client);
  if (!['paste', 'input', 'proxy', 'pair.code'].includes(msg.op)) pushState();
  return result;
}

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 } });

wss.on('connection', (ws, req, who) => {
  const client = {
    ws, who, focus: null, visible: true, inputAt: 0, subs: new Map(),
    raw(s) { if (ws.readyState === 1 && ws.bufferedAmount < 32 * 1024 * 1024) ws.send(s); },
    send(m) { this.raw(JSON.stringify(m)); },
  };
  clients.add(client);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  client.send({ t: 'hello', who, state: publicState(), proxies: proxies.list() });
  log('client connected', who, normalizeIp(req.socket.remoteAddress));

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    try {
      switch (m.t) {
        case 'i': {
          client.inputAt = Date.now();
          terms.get(m.id)?.write(m.d);
          break;
        }
        case 'sub': {
          const t = terms.get(m.id);
          if (!t || client.subs.has(m.id)) break;
          client.subs.set(m.id, t.subscribe((msg) => client.send(msg), { scrollback: m.scrollback }));
          break;
        }
        case 'unsub': {
          client.subs.get(m.id)?.();
          client.subs.delete(m.id);
          break;
        }
        case 'resize': {
          const t = terms.get(m.id);
          if (t && t.resize(m.cols, m.rows)) {
            const s = state.surfaces[m.id];
            if (s) { s.cols = t.cols; s.rows = t.rows; saveState(); }
            broadcast({ t: 'size', id: m.id, cols: t.cols, rows: t.rows, by: m.by });
          }
          break;
        }
        case 'focus': {
          client.focus = m.id || null;
          client.visible = m.visible !== false;
          if (m.active) client.inputAt = Date.now();
          const s = m.id && state.surfaces[m.id];
          if (s && client.visible) {
            state.lastActive = { ws: s.ws, surface: s.id, at: Date.now() };
            const loc = locate(m.id);
            if (loc?.pane) { loc.pane.active = m.id; loc.ws.focusPane = loc.pane.id; }
            if (s.unread) s.unread = false;
            pushState();
          }
          break;
        }
        case 'op': {
          const result = await runOp(m, client);
          if (m.req) client.send({ t: 'reply', req: m.req, result });
          break;
        }
        case 'ping':
          client.send({ t: 'pong', ts: m.ts });
          break;
      }
    } catch (e) {
      log('ws error', e);
      if (m.req) client.send({ t: 'reply', req: m.req, error: String(e.message || e) });
    }
  });

  ws.on('close', () => {
    for (const un of client.subs.values()) un();
    clients.delete(client);
  });
});

setInterval(() => {
  for (const c of clients) {
    if (!c.ws.isAlive) { c.ws.terminate(); continue; }
    c.ws.isAlive = false;
    try { c.ws.ping(); } catch {}
  }
}, 20_000);

// ---------------------------------------------------------------- http
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
};

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function body(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  let p = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || p === '') p = '/index.html';
  let file = path.join(WEB, p);
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(500); res.end('web/dist missing: run npm run build:web'); return; }
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

const PAIR_PAGE = (msg = '') => `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=apple-mobile-web-app-capable content=yes><meta name=theme-color content="#0d1110"><title>frog · pair</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0d1110;color:#d7e0da;font:15px -apple-system,system-ui,sans-serif}form{display:grid;gap:14px;width:min(320px,86vw);text-align:center}h1{margin:0;font-size:22px}p{color:#8a978f;margin:0;line-height:1.4}input{font:28px ui-monospace,Menlo,monospace;letter-spacing:8px;text-align:center;padding:12px;border-radius:10px;border:1px solid #2a3530;background:#141a17;color:#fff}button{padding:12px;border:0;border-radius:10px;background:#4ade80;color:#06210f;font-weight:600;font-size:16px}.e{color:#f87171}</style></head>
<body><form method=post action="/pair"><h1>🐸 Pair this device</h1><p>On a device that's already connected, open frog → <b>Pair device</b> and enter the code here.</p><input name=code inputmode=numeric autocomplete=one-time-code maxlength=6 autofocus placeholder="000000"><input type=hidden name=name id=n><button>Pair</button><p class=e>${msg}</p></form><script>document.getElementById('n').value=navigator.userAgent.match(/iPhone|iPad|Android|Mac|Windows|Linux/)?.[0]||'device'</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!isLoopback(req.socket.remoteAddress) && !/^\/(assets|api)\//.test(url.pathname)) log('http', normalizeIp(req.socket.remoteAddress), req.method, url.pathname);
  try {
    if (url.pathname === '/pair' && req.method === 'POST') {
      const params = new URLSearchParams(await body(req, 4096));
      const token = auth.redeem(req, params.get('code') || '', params.get('name'));
      if (!token) { res.writeHead(401, { 'content-type': 'text/html' }); res.end(PAIR_PAGE('Wrong or expired code.')); return; }
      res.writeHead(302, { location: '/', 'set-cookie': `frog_token=${token}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly` });
      res.end();
      return;
    }
    if (url.pathname === '/healthz') { res.setHeader('access-control-allow-origin', '*'); return sendJSON(res, 200, { ok: true, name: 'frog' }); }
    if (/^\/(manifest\.webmanifest|icon[\w-]*\.(png|svg)|favicon\.ico)$/.test(url.pathname)) return serveStatic(res, url.pathname);

    const a = await auth.check(req);
    if (!a.ok) {
      if (a.reason === 'pair') { res.writeHead(401, { 'content-type': 'text/html' }); res.end(PAIR_PAGE()); }
      else { res.writeHead(403); res.end('frog: only reachable over Tailscale'); }
      return;
    }

    if (url.pathname === '/api/cli' && req.method === 'POST') {
      if (!isLoopback(req.socket.remoteAddress)) return sendJSON(res, 403, { error: 'local only' });
      return sendJSON(res, 200, await cli(JSON.parse(await body(req))));
    }
    if (url.pathname.startsWith('/api/fs/')) return await fsApi(req, res, url);
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      // Pasted/dropped files land here so Claude Code on this host can read them.
      const dir = path.join(DATA, 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      const name = (url.searchParams.get('name') || 'file').replace(/[^\w.-]+/g, '_').slice(-80);
      const file = path.join(dir, `${Date.now().toString(36)}-${name}`);
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(file);
        req.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
      });
      return sendJSON(res, 200, { path: file });
    }
    return serveStatic(res, url.pathname);
  } catch (e) {
    sendJSON(res, e.status || 500, { error: String(e.message || e), mtime: e.mtime });
  }
});

async function fsApi(req, res, url) {
  const p = url.searchParams.get('path');
  switch (url.pathname) {
    case '/api/fs/list': return sendJSON(res, 200, { path: files.expand(p), entries: await files.list(p) });
    case '/api/fs/read': return sendJSON(res, 200, await files.read(p));
    case '/api/fs/stat': return sendJSON(res, 200, await files.stat(p));
    case '/api/fs/files': return sendJSON(res, 200, await files.files(p));
    case '/api/fs/write': {
      const b = JSON.parse(await body(req));
      return sendJSON(res, 200, await files.write(b.path, b.content, b.mtime));
    }
  }
  sendJSON(res, 404, { error: 'not found' });
}

// Commands from the `frog` CLI running inside a frog terminal.
async function cli({ cmd, surface, args = {} }) {
  const loc = surface && locate(surface);
  switch (cmd) {
    case 'notify':
      if (!state.surfaces[surface]) return { ok: false, error: 'not inside a frog terminal' };
      notify(surface, { title: args.title, body: args.body, source: 'cli' });
      return { ok: true };
    case 'open':
    case 'edit': {
      if (!loc) return { ok: false, error: 'not inside a frog terminal' };
      const kind = cmd === 'open' ? 'browser' : 'editor';
      const opts = cmd === 'open' ? { url: args.url } : { file: args.file, line: args.line };
      const r = args.split
        ? ops['pane.split']({ ws: loc.ws.id, pane: loc.pane.id, dir: args.split, kind, ...opts })
        : ops['surface.new']({ ws: loc.ws.id, pane: loc.pane.id, kind, ...opts });
      pushState();
      broadcast({ t: 'reveal', id: r.surface });
      return { ok: true, ...r };
    }
    case 'split': {
      if (!loc) return { ok: false, error: 'not inside a frog terminal' };
      const r = ops['pane.split']({ ws: loc.ws.id, pane: loc.pane.id, dir: args.dir || 'right', kind: 'terminal' });
      pushState();
      return { ok: true, ...r };
    }
    case 'rename':
      if (!loc) return { ok: false };
      ops['ws.rename']({ id: loc.ws.id, name: args.name });
      pushState();
      return { ok: true };
    case 'status':
      return { ok: true, workspaces: state.workspaces.length, terminals: terms.size, clients: clients.size };
  }
  return { ok: false, error: 'unknown command' };
}

server.on('connection', (sock) => {
  const ip = normalizeIp(sock.remoteAddress);
  if (!isLoopback(ip)) sock.once('data', (b) => { if (b[0] === 0x16) log('tls handshake on http port from', ip); });
});
server.on('clientError', (err, sock) => { if (err.code !== 'ECONNRESET') log('client error', normalizeIp(sock.remoteAddress), err.code); sock.destroy(); });

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const a = await auth.check(req);
  if (!a.ok) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, a.who));
});

// ---------------------------------------------------------------- boot / shutdown
async function boot() {
  if (!config.allowedLogins?.length) {
    const me = await auth.ownLogin();
    if (me) {
      config.allowedLogins = [me];
      const file = path.join(DATA, 'config.json');
      fs.writeFileSync(file, JSON.stringify({ ...readJSON(file, {}), allowedLogins: [me] }, null, 2));
      log(`allowing Tailscale devices signed in as ${me} (edit ${file} to change)`);
    } else log('Tailscale not found: other devices must pair with a code');
  }
  // Repair state from disk: drop dangling surfaces, respawn terminals.
  for (const ws of state.workspaces) {
    for (const p of panesOf(ws.layout)) {
      p.surfaces = p.surfaces.filter((id) => state.surfaces[id]);
      if (!p.surfaces.includes(p.active)) p.active = p.surfaces[0] || null;
    }
  }
  const referenced = new Set(state.workspaces.flatMap((w) => panesOf(w.layout).flatMap((p) => p.surfaces)));
  for (const id of Object.keys(state.surfaces)) if (!referenced.has(id)) delete state.surfaces[id];
  for (const ws of [...state.workspaces]) for (const p of panesOf(ws.layout)) if (!p.surfaces.length) closePane(ws, p.id);
  for (const s of Object.values(state.surfaces)) {
    if (s.kind !== 'terminal') continue;
    let restore = '';
    try { restore = fs.readFileSync(path.join(DATA, 'scrollback', s.id + '.txt'), 'utf8'); } catch {}
    spawnTerm(s, await prepareRestore(restore, s.cols || 120, s.rows || 32));
  }
  if (!state.workspaces.length) newWorkspace();
  saveState();
}

function saveScrollback() {
  for (const [id, t] of terms) {
    try { fs.writeFileSync(path.join(DATA, 'scrollback', id + '.txt'), t.snapshotForRestore()); } catch {}
  }
}
// Windows services get killed without a signal; keep a recent copy on disk.
setInterval(saveScrollback, 60_000).unref();

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down on', sig);
  saveScrollback();
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(state));
  for (const t of terms.values()) t.kill();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGBREAK', () => shutdown('SIGBREAK'));
process.on('uncaughtException', (e) => log('uncaught', e));
process.on('unhandledRejection', (e) => log('unhandled', e));

await boot();
server.listen(config.port, config.host, () => log(`frog listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port} (shell ${SHELL}, data ${DATA})`));
