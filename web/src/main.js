import '@xterm/xterm/css/xterm.css';
import './style.css';
import qrcode from 'qrcode-generator';
import { connect } from './conn.js';
import { TermView } from './terminal.js';
import { BrowserView, normalizeUrl } from './browser.js';
import { EditorViewSurface } from './editor.js';
import { icon, IS_MAC, kbd, fixKeyLabels } from './icons.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isMobile = () => innerWidth < 760;
const desktopShell = window.frogDesktop || null; // set by the Electron preload

const app = {
  clientId: Math.random().toString(36).slice(2, 10),
  mobile: isMobile(),
  fontSize: +(localStorage.getItem('frog.font') || (isMobile() ? 11 : 13)),
  state: null,
  views: new Map(),
  activeWs: localStorage.getItem('frog.ws') || null,
  focused: null,
  lastFocusByWs: {},
  lastTermByWs: {},
  layoutSig: '',
  hiddenAt: 0,
};
window.frog = app;

document.body.innerHTML = `
<div id="app">
  <aside id="sidebar">
    <div class="sb-head"><span class="logo">🐸 frog</span><span class="sb-host"></span><button class="ib new-ws" title="New workspace (⌘N)">${icon('plus')}</button></div>
    <div class="ws-list"></div>
    <div class="sb-foot">
      <span class="conn"><span class="conn-dot"></span><span class="conn-text">connecting</span></span>
      <button class="ib pair" title="Pair a phone or another computer">${icon('phone')}<span>Pair device</span></button>
    </div>
    <div class="sb-resize"></div>
  </aside>
  <div id="scrim"></div>
  <main id="main">
    <div id="stage"></div>
    <div id="layer"></div>
    <div id="keybar"></div>
  </main>
</div>
<div id="toast"></div>
<div id="offline">Reconnecting to frog…</div>`;

const stage = $('#stage');
const layer = $('#layer');

// ---------------------------------------------------------------- connection
app.conn = connect({
  onStatus(s) {
    document.body.dataset.conn = s;
    $('.conn-text').textContent = s === 'open' ? (app.state?.host || 'connected') : s;
    clearTimeout(app.offT);
    if (s === 'open') $('#offline').classList.remove('show');
    else app.offT = setTimeout(() => $('#offline').classList.add('show'), 1200);
  },
  onMessage(m) {
    switch (m.t) {
      case 'hello': {
        const first = !app.state;
        app.who = m.who;
        setState(m.state);
        for (const v of app.views.values()) v.resubscribe?.();
        if (first || app.mobile) jumpToLastActive();
        sendFocus();
        break;
      }
      case 'state': setState(m.state); break;
      case 'snap': app.views.get(m.id)?.onSnap?.(m); break;
      case 'o': app.views.get(m.id)?.onOutput?.(m.d); break;
      case 'size': app.views.get(m.id)?.onSize?.(m); break;
      case 'notify': onNotify(m); break;
      case 'reveal': setTimeout(() => reveal(m.id), 50); break;
    }
  },
});

function setState(s) {
  app.state = s;
  $('.sb-host').textContent = s.host?.replace(/\.local$/, '') || '';
  if (!s.workspaces.find((w) => w.id === app.activeWs)) app.activeWs = s.lastActive?.ws && s.workspaces.find((w) => w.id === s.lastActive.ws) ? s.lastActive.ws : s.workspaces[0]?.id;
  syncViews();
  render();
}

function jumpToLastActive() {
  const la = app.state?.lastActive;
  if (!la || !app.state.surfaces[la.surface]) return;
  activateWorkspace(la.ws, { surface: la.surface });
}

// ---------------------------------------------------------------- helpers
app.stateOf = (id) => app.state?.surfaces[id];
app.shortPath = (p) => (p && app.state?.home && p.startsWith(app.state.home) ? '~' + p.slice(app.state.home.length) : p || '');
const wsById = (id) => app.state?.workspaces.find((w) => w.id === id);
const panesOf = (n, out = []) => { if (!n) return out; if (n.type === 'pane') out.push(n); else n.children.forEach((c) => panesOf(c, out)); return out; };
const surfacesOf = (ws) => panesOf(ws.layout).flatMap((p) => p.surfaces).filter((id) => app.state.surfaces[id]);
const paneOfSurface = (ws, id) => panesOf(ws.layout).find((p) => p.surfaces.includes(id));
app.portsForWorkspace = (wsId) => {
  const ws = wsById(wsId);
  if (!ws) return [];
  const set = new Set();
  for (const id of surfacesOf(ws)) for (const p of app.state.live[id]?.ports || []) set.add(p);
  return [...set].sort((a, b) => a - b);
};

function surfaceTitle(s) {
  const lv = app.state.live[s.id] || {};
  if (s.kind === 'terminal') {
    const t = (s.termTitle || '').trim();
    const base = app.shortPath(lv.cwd || s.cwd).split('/').pop() || '~';
    if (lv.proc && t && !t.includes(base) && t !== lv.proc) return t;
    if (lv.proc) return `${lv.proc} · ${base}`;
    return t && !/^(zsh|bash|fish|-zsh)$/.test(t) ? t : base;
  }
  return s.title || s.kind;
}

const KIND_ICON = { terminal: 'terminal', browser: 'globe', editor: 'code' };

// ---------------------------------------------------------------- views
function syncViews() {
  const s = app.state;
  for (const [id, v] of app.views) {
    if (!s.surfaces[id]) { v.dispose(); app.views.delete(id); }
  }
  for (const sur of Object.values(s.surfaces)) {
    let v = app.views.get(sur.id);
    // Create views lazily: only for the active workspace (and keep them afterwards).
    if (!v && sur.ws === app.activeWs) {
      v = sur.kind === 'terminal' ? new TermView(app, sur) : sur.kind === 'browser' ? new BrowserView(app, sur) : new EditorViewSurface(app, sur);
      app.views.set(sur.id, v);
      layer.appendChild(v.el);
      fixKeyLabels(v.el);
    } else if (v && v.sync) v.sync(sur);
  }
}

// ---------------------------------------------------------------- render
function render() {
  if (!app.state) return;
  renderSidebar();
  renderStage();
  positionViews();
  updateBadge();
  fixKeyLabels();
}

function wsSummary(ws) {
  const s = app.state;
  const ids = surfacesOf(ws);
  const unread = ids.filter((id) => s.surfaces[id].unread);
  const notif = ids.map((id) => s.surfaces[id].notif).filter(Boolean).sort((a, b) => b.ts - a.ts)[0];
  const termId = [app.lastTermByWs[ws.id], ...ids].find((id) => s.surfaces[id]?.kind === 'terminal');
  const lv = (termId && s.live[termId]) || {};
  const procs = [...new Set(ids.map((id) => s.live[id]?.proc).filter(Boolean))];
  return { unread: unread.length, notif, cwd: lv.cwd || ws.cwd, git: lv.git, ports: app.portsForWorkspace(ws.id), procs, count: ids.length };
}

function ago(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'now';
  if (d < 3600) return Math.floor(d / 60) + 'm';
  if (d < 86400) return Math.floor(d / 3600) + 'h';
  return Math.floor(d / 86400) + 'd';
}

function renderSidebar() {
  const list = $('.ws-list');
  const html = app.state.workspaces.map((ws, i) => {
    const m = wsSummary(ws);
    const active = ws.id === app.activeWs;
    const showNotif = m.notif && (m.unread || Date.now() - m.notif.ts < 30 * 60_000);
    return `<div class="ws ${active ? 'active' : ''} ${m.unread ? 'unread' : ''}" data-ws="${ws.id}" draggable="true">
      <div class="ws-row1"><span class="ws-dot"></span><span class="ws-name">${esc(ws.name)}</span>${m.procs.includes('claude') ? '<span class="ws-proc">✻</span>' : ''}${i < 9 ? `<span class="ws-key">⌘${i + 1}</span>` : ''}<button class="ws-close" title="Close workspace">${icon('x', 12)}</button></div>
      <div class="ws-row2">${m.git ? `<span class="ws-git">⎇ ${esc(m.git)}</span>` : ''}<span class="ws-cwd">${esc(app.shortPath(m.cwd))}</span></div>
      ${showNotif ? `<div class="ws-notif"><span>${esc(m.notif.body || m.notif.title)}</span><em>${ago(m.notif.ts)}</em></div>` : ''}
      ${m.ports.length ? `<div class="ws-ports">${m.ports.map((p) => `<button class="port" data-port="${p}">:${p}</button>`).join('')}</div>` : ''}
    </div>`;
  }).join('');
  if (list._html !== html) {
    list._html = html;
    list.innerHTML = html;
  }
}

$('.ws-list').addEventListener('click', (e) => {
  const item = e.target.closest('.ws');
  if (!item) return;
  const id = item.dataset.ws;
  if (e.target.closest('.ws-close')) { closeWorkspace(id); return; }
  const port = e.target.closest('.port');
  if (port) { activateWorkspace(id); openBrowser('http://localhost:' + port.dataset.port, { split: !app.mobile }); return; }
  activateWorkspace(id);
  if (app.mobile) document.body.classList.remove('drawer');
});
$('.ws-list').addEventListener('dblclick', (e) => {
  const item = e.target.closest('.ws');
  if (!item) return;
  const name = item.querySelector('.ws-name');
  name.contentEditable = 'true';
  name.focus();
  document.getSelection().selectAllChildren(name);
  const done = (save) => {
    name.contentEditable = 'false';
    name.onblur = name.onkeydown = null;
    if (save) app.conn.op('ws.rename', { id: item.dataset.ws, name: name.textContent.trim() });
    else renderSidebar();
  };
  name.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); done(true); } if (ev.key === 'Escape') done(false); ev.stopPropagation(); };
  name.onblur = () => done(true);
});
// Drag to reorder workspaces; drop a tab on a workspace to move it there.
$('.ws-list').addEventListener('dragstart', (e) => {
  const item = e.target.closest('.ws');
  if (item) { e.dataTransfer.setData('frog/ws', item.dataset.ws); e.dataTransfer.effectAllowed = 'move'; }
});
$('.ws-list').addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('frog/ws') || e.dataTransfer.types.includes('frog/surface')) { e.preventDefault(); e.target.closest('.ws')?.classList.add('drop'); }
});
$('.ws-list').addEventListener('dragleave', (e) => e.target.closest('.ws')?.classList.remove('drop'));
$('.ws-list').addEventListener('drop', (e) => {
  const item = e.target.closest('.ws');
  item?.classList.remove('drop');
  if (!item) return;
  const wsId = e.dataTransfer.getData('frog/ws');
  const sid = e.dataTransfer.getData('frog/surface');
  if (wsId) app.conn.op('ws.move', { id: wsId, to: app.state.workspaces.findIndex((w) => w.id === item.dataset.ws) });
  if (sid) app.conn.op('surface.toWorkspace', { id: sid, ws: item.dataset.ws });
});
$('.new-ws').onclick = () => newWorkspace();
$('.pair').onclick = () => pairDialog();
$('#scrim').onclick = () => document.body.classList.remove('drawer');

// Sidebar width
{
  const h = $('.sb-resize');
  const w = localStorage.getItem('frog.sbw');
  if (w) document.documentElement.style.setProperty('--sb-w', w + 'px');
  h.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    const move = (ev) => {
      const nw = Math.max(160, Math.min(420, ev.clientX));
      document.documentElement.style.setProperty('--sb-w', nw + 'px');
      localStorage.setItem('frog.sbw', nw);
      positionViews();
    };
    const up = () => { document.body.classList.remove('resizing'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}

function layoutSignature(ws) {
  const sig = (n) => (n.type === 'pane' ? `p:${n.id}` : `s:${n.id}:${n.dir}(${n.children.map(sig).join(',')})`);
  return `${app.mobile}|${ws.id}|${sig(ws.layout)}`;
}

function renderStage() {
  const ws = wsById(app.activeWs);
  if (!ws) { stage.innerHTML = ''; return; }
  const sig = layoutSignature(ws);
  if (sig !== app.layoutSig) {
    app.layoutSig = sig;
    stage.innerHTML = '';
    stage.appendChild(app.mobile ? buildMobile(ws) : buildNode(ws, ws.layout));
  }
  // Ratios and tab strips change without a rebuild.
  if (!app.mobile) {
    stage.querySelectorAll('.split').forEach((el) => {
      const hit = findSplit(ws.layout, el.dataset.split);
      if (hit && !el._dragging) setRatio(el, hit.ratio);
    });
    for (const p of panesOf(ws.layout)) {
      const el = stage.querySelector(`[data-pane="${p.id}"]`);
      if (el) renderTabs(el.querySelector('.tabs-list'), ws, p.surfaces, p.active);
      el?.classList.toggle('attention', p.surfaces.some((id) => app.state.surfaces[id]?.unread));
    }
  } else {
    const cur = mobileCurrent(ws);
    renderTabs(stage.querySelector('.tabs-list'), ws, surfacesOf(ws), cur);
    $('.m-title', stage).textContent = ws.name;
    renderKeybar(app.state.surfaces[cur]?.kind === 'terminal' ? cur : null);
  }
  markFocus();
}

function findSplit(n, id) {
  if (n.type !== 'split') return null;
  if (n.id === id) return n;
  for (const c of n.children) { const r = findSplit(c, id); if (r) return r; }
  return null;
}

function setRatio(el, r) {
  el.children[0].style.flex = `${r} 1 0px`;
  el.children[2].style.flex = `${1 - r} 1 0px`;
}

function buildNode(ws, n) {
  if (n.type === 'pane') {
    const el = document.createElement('div');
    el.className = 'pane';
    el.dataset.pane = n.id;
    el.innerHTML = `<div class="tabs"><div class="tabs-list"></div><div class="pane-actions">
      <button class="ib" data-act="terminal" title="New terminal tab (⌘T)">${icon('terminal')}</button>
      <button class="ib" data-act="browser" title="New browser tab (⌘B)">${icon('globe')}</button>
      <button class="ib" data-act="editor" title="New editor tab (⌘E)">${icon('code')}</button>
      <span class="sep"></span>
      <button class="ib" data-act="right" title="Split right (⌘D)">${icon('splitRight')}</button>
      <button class="ib" data-act="down" title="Split down (⌘⇧D)">${icon('splitDown')}</button>
    </div></div><div class="pane-body" data-body="${n.id}"><div class="dropzone"></div></div>`;
    el.querySelector('.pane-actions').onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'right' || act === 'down') split(n.id, act, kindOfFocused());
      else newSurface(act, { pane: n.id });
    };
    el.addEventListener('mousedown', () => {
      if (!app.focused || !n.surfaces.includes(app.focused)) n.active && app.focusSurface(n.active);
    });
    installPaneDrop(el, ws, n);
    return el;
  }
  const el = document.createElement('div');
  el.className = 'split ' + n.dir;
  el.dataset.split = n.id;
  const a = document.createElement('div'); a.className = 'child';
  const b = document.createElement('div'); b.className = 'child';
  const d = document.createElement('div'); d.className = 'divider';
  a.appendChild(buildNode(ws, n.children[0]));
  b.appendChild(buildNode(ws, n.children[1]));
  el.append(a, d, b);
  setRatio(el, n.ratio);
  d.addEventListener('mousedown', (e) => {
    e.preventDefault();
    el._dragging = true;
    document.body.classList.add('resizing', n.dir === 'row' ? 'resizing-x' : 'resizing-y');
    const rect = el.getBoundingClientRect();
    let r = n.ratio;
    const move = (ev) => {
      r = n.dir === 'row' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      r = Math.max(0.08, Math.min(0.92, r));
      setRatio(el, r);
      positionViews();
    };
    const up = () => {
      el._dragging = false;
      document.body.classList.remove('resizing', 'resizing-x', 'resizing-y');
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      app.conn.op('pane.ratio', { ws: ws.id, split: n.id, ratio: r });
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
  d.addEventListener('dblclick', () => app.conn.op('pane.ratio', { ws: ws.id, split: n.id, ratio: 0.5 }));
  return el;
}

function renderTabs(list, ws, ids, active) {
  if (!list) return;
  const html = ids.map((id) => {
    const s = app.state.surfaces[id];
    if (!s) return '';
    return `<div class="tab ${id === active ? 'active' : ''} ${s.unread ? 'unread' : ''} k-${s.kind}" data-sid="${id}" draggable="${!app.mobile}" title="${esc(surfaceTitle(s))}">
      ${icon(KIND_ICON[s.kind], 13)}<span class="tab-title">${esc(surfaceTitle(s))}</span><span class="tab-dot"></span><button class="tab-close" title="Close (⌘W)">${icon('x', 11)}</button></div>`;
  }).join('');
  if (list._html === html) return;
  list._html = html;
  list.innerHTML = html;
  list.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

stage.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  const id = tab.dataset.sid;
  if (e.target.closest('.tab-close')) { closeSurface(id); return; }
  app.focusSurface(id, { claim: true, focusView: true });
});
stage.addEventListener('auxclick', (e) => {
  const tab = e.target.closest('.tab');
  if (tab && e.button === 1) closeSurface(tab.dataset.sid);
});
stage.addEventListener('dragstart', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  e.dataTransfer.setData('frog/surface', tab.dataset.sid);
  e.dataTransfer.effectAllowed = 'move';
  document.body.classList.add('dragging-tab');
});
addEventListener('dragend', () => {
  document.body.classList.remove('dragging-tab');
  stage.querySelectorAll('.dropzone').forEach((z) => (z.className = 'dropzone'));
});

// Dropping a tab onto a pane: edges split, center moves it into that pane.
function installPaneDrop(el, ws, pane) {
  const body = el.querySelector('.pane-body');
  const zone = el.querySelector('.dropzone');
  const where = (e) => {
    const r = body.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    if (x < 0.25) return 'left';
    if (x > 0.75) return 'right';
    if (y < 0.25) return 'up';
    if (y > 0.75) return 'down';
    return 'center';
  };
  body.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('frog/surface')) return;
    e.preventDefault();
    zone.className = 'dropzone show ' + where(e);
  });
  body.addEventListener('dragleave', () => (zone.className = 'dropzone'));
  body.addEventListener('drop', (e) => {
    const sid = e.dataTransfer.getData('frog/surface');
    zone.className = 'dropzone';
    if (!sid) return;
    e.preventDefault();
    const w = where(e);
    if (w === 'center') app.conn.op('surface.move', { id: sid, pane: pane.id });
    else {
      const src = paneOfSurface(ws, sid);
      if (src && src.id === pane.id && pane.surfaces.length < 2) return;
      if (src && src.id !== pane.id) {
        // Move first, then split it out of the destination pane.
        app.conn.op('surface.move', { id: sid, pane: pane.id }).then(() => app.conn.op('pane.split', { ws: ws.id, pane: pane.id, dir: w, surface: sid }));
      } else app.conn.op('pane.split', { ws: ws.id, pane: pane.id, dir: w, surface: sid });
    }
  });
  el.querySelector('.tabs').addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('frog/surface')) e.preventDefault(); });
  el.querySelector('.tabs').addEventListener('drop', (e) => {
    const sid = e.dataTransfer.getData('frog/surface');
    if (!sid) return;
    e.preventDefault();
    const tabs = [...el.querySelectorAll('.tab')];
    let index = tabs.findIndex((t) => { const r = t.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; });
    if (index < 0) index = tabs.length;
    app.conn.op('surface.move', { id: sid, pane: pane.id, index });
  });
}

// ---------------------------------------------------------------- mobile layout
function mobileCurrent(ws) {
  const ids = surfacesOf(ws);
  if (app.focused && ids.includes(app.focused)) return app.focused;
  const last = app.lastFocusByWs[ws.id];
  if (last && ids.includes(last)) return last;
  const fp = panesOf(ws.layout).find((p) => p.id === ws.focusPane);
  return fp?.active || ids[0];
}

function buildMobile(ws) {
  const el = document.createElement('div');
  el.className = 'm-wrap';
  el.innerHTML = `<div class="m-top"><button class="ib m-menu">${icon('menu', 18)}<span class="m-badge"></span></button><span class="m-title"></span>
      <button class="ib m-add" title="New tab">${icon('plus', 18)}</button></div>
    <div class="tabs m-tabs"><div class="tabs-list"></div></div>
    <div class="pane-body" data-body="mobile"></div>`;
  el.querySelector('.m-menu').onclick = () => document.body.classList.toggle('drawer');
  el.querySelector('.m-add').onclick = () => menu(el.querySelector('.m-add'), [
    { label: 'Terminal', icon: 'terminal', run: () => newSurface('terminal') },
    { label: 'Browser', icon: 'globe', run: () => newSurface('browser') },
    { label: 'Editor', icon: 'code', run: () => newSurface('editor') },
  ]);
  return el;
}

const KEYS = [
  ['esc', '\x1b'], ['tab', '\t'], ['⇧tab', '\x1b[Z'], ['ctrl', 'CTRL'], ['alt', 'ALT'],
  ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
  ['^C', '\x03'], ['^D', '\x04'], ['^R', '\x12'], ['/', '/'], ['|', '|'], ['~', '~'], ['-', '-'], ['enter', '\r'],
];

function renderKeybar(termId) {
  const bar = $('#keybar');
  document.body.classList.toggle('has-keybar', !!termId);
  bar.dataset.term = termId || '';
  if (!termId) return;
  if (!bar._built) {
    bar._built = true;
    bar.innerHTML = `<div class="kb-row">
      <button class="k k-compose" data-k="COMPOSE">${icon('keyboard', 14)} Write</button>
      ${KEYS.map(([l, k]) => `<button class="k" data-k="${esc(k)}">${l}</button>`).join('')}
      <button class="k" data-k="PASTE">${icon('paste', 13)}</button>
      <button class="k" data-k="COPY">${icon('copy', 13)}</button>
      <button class="k" data-k="FONT+">A+</button><button class="k" data-k="FONT-">A−</button></div>`;
    const press = (e) => {
      const b = e.target.closest('.k');
      if (!b) return;
      e.preventDefault();
      const id = bar.dataset.term;
      const v = app.views.get(id);
      if (!v) return;
      const k = b.dataset.k;
      if (k === 'CTRL') v.setCtrl(!v.ctrlLatch);
      else if (k === 'ALT') v.setAlt(!v.altLatch);
      else if (k === 'COMPOSE') compose(id);
      else if (k === 'PASTE') pasteSheet(id);
      else if (k === 'COPY') copySheet(id);
      else if (k === 'FONT+') setFont(app.fontSize + 1);
      else if (k === 'FONT-') setFont(app.fontSize - 1);
      else {
        let d = k;
        if (v.ctrlLatch && d.length === 1) { d = String.fromCharCode(d.toUpperCase().charCodeAt(0) & 0x1f); v.setCtrl(false); }
        if (v.altLatch) { d = '\x1b' + d; v.setAlt(false); }
        v.input(d);
      }
      renderLatches();
    };
    // pointerdown + preventDefault keeps the iOS keyboard open.
    bar.addEventListener('pointerdown', press);
    bar.addEventListener('click', (e) => e.preventDefault());
  }
  renderLatches();
}
app.onLatch = () => renderLatches();
function renderLatches() {
  const v = app.views.get($('#keybar').dataset.term);
  $('#keybar').querySelector('[data-k="CTRL"]')?.classList.toggle('on', !!v?.ctrlLatch);
  $('#keybar').querySelector('[data-k="ALT"]')?.classList.toggle('on', !!v?.altLatch);
}

// Native text box for the phone: dictation, autocorrect and paste all work here.
function compose(id) {
  sheet({
    title: 'Write to terminal',
    body: `<textarea class="compose" rows="5" placeholder="Type or dictate a prompt…"></textarea>
      <div class="sheet-actions"><label><input type="checkbox" class="send-enter" checked> press Enter</label><button class="btn primary send">Send</button></div>`,
    onOpen(el) {
      const ta = el.querySelector('textarea');
      ta.value = localStorage.getItem('frog.draft') || '';
      ta.oninput = () => localStorage.setItem('frog.draft', ta.value);
      setTimeout(() => ta.focus(), 50);
      el.querySelector('.send').onclick = () => {
        const text = ta.value;
        if (text) app.conn.op('paste', { id, text });
        if (el.querySelector('.send-enter').checked) setTimeout(() => app.conn.op('input', { id, data: '\r' }), 60);
        localStorage.removeItem('frog.draft');
        el.close();
      };
    },
  });
}

function pasteSheet(id) {
  sheet({
    title: 'Paste',
    body: `<textarea class="compose" rows="5" placeholder="Long-press here and choose Paste"></textarea><div class="sheet-actions"><span></span><button class="btn primary send">Paste into terminal</button></div>`,
    onOpen(el) {
      const ta = el.querySelector('textarea');
      setTimeout(() => ta.focus(), 50);
      navigator.clipboard?.readText?.().then((t) => { if (t) ta.value = t; }).catch(() => {});
      el.querySelector('.send').onclick = () => { if (ta.value) app.conn.op('paste', { id, text: ta.value }); el.close(); };
    },
  });
}

function copySheet(id) {
  const v = app.views.get(id);
  sheet({
    title: 'Select text to copy',
    body: `<pre class="copy-text"></pre>`,
    onOpen(el) {
      const pre = el.querySelector('pre');
      pre.textContent = v?.plainText(300) || '';
      requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight));
    },
  });
}

// ---------------------------------------------------------------- positioning views over pane bodies
function positionViews() {
  const ws = wsById(app.activeWs);
  const L = layer.getBoundingClientRect();
  const shown = new Map(); // surfaceId -> rect
  if (ws) {
    if (app.mobile) {
      const cur = mobileCurrent(ws);
      const body = stage.querySelector('[data-body="mobile"]');
      if (cur && body) shown.set(cur, body.getBoundingClientRect());
    } else {
      for (const p of panesOf(ws.layout)) {
        const body = stage.querySelector(`[data-body="${p.id}"]`);
        if (body && p.active) shown.set(p.active, body.getBoundingClientRect());
      }
    }
  }
  for (const [id, v] of app.views) {
    const r = shown.get(id);
    if (r) {
      const st = v.el.style;
      st.display = '';
      st.left = r.left - L.left + 'px';
      st.top = r.top - L.top + 'px';
      st.width = r.width + 'px';
      st.height = r.height + 'px';
      v.setVisible(true);
    } else if (v.el.style.display !== 'none') {
      v.el.style.display = 'none';
      v.setVisible(false);
    }
  }
}
new ResizeObserver(() => positionViews()).observe(stage);

function markFocus() {
  stage.querySelectorAll('.pane').forEach((el) => {
    const ws = wsById(app.activeWs);
    const p = ws && panesOf(ws.layout).find((x) => x.id === el.dataset.pane);
    el.classList.toggle('focused', !!p && p.surfaces.includes(app.focused));
  });
  for (const [id, v] of app.views) v.el.classList.toggle('focused', id === app.focused);
}

// ---------------------------------------------------------------- focus & actions
app.focusSurface = (id, { claim, focusView } = {}) => {
  const s = app.state?.surfaces[id];
  if (!s) return;
  if (s.ws !== app.activeWs) { activateWorkspace(s.ws, { surface: id }); return; }
  const changed = app.focused !== id;
  app.focused = id;
  app.lastFocusByWs[s.ws] = id;
  if (s.kind === 'terminal') app.lastTermByWs[s.ws] = id;
  if (changed || s.unread) {
    // Optimistic: show the tab now, server confirms.
    const ws = wsById(s.ws);
    const p = ws && paneOfSurface(ws, id);
    if (p) { p.active = id; ws.focusPane = p.id; }
    s.unread = false;
    sendFocus(true);
    renderStage();
    renderSidebar();
    positionViews();
    updateBadge();
  }
  const v = app.views.get(id);
  if (v && (focusView || changed)) {
    if (!app.mobile || s.kind !== 'terminal' || focusView) requestAnimationFrame(() => v.focus());
  }
  if (claim && v?.claim) v.claim();
};

function sendFocus(active) {
  app.conn.send({ t: 'focus', id: app.focused, visible: document.visibilityState === 'visible' && (document.hasFocus() || app.mobile), active });
}

function activateWorkspace(id, { surface } = {}) {
  const ws = wsById(id);
  if (!ws) return;
  app.activeWs = id;
  localStorage.setItem('frog.ws', id);
  syncViews();
  render();
  const ids = surfacesOf(ws);
  const target = (surface && ids.includes(surface) && surface) || (app.lastFocusByWs[id] && ids.includes(app.lastFocusByWs[id]) && app.lastFocusByWs[id]) || panesOf(ws.layout).find((p) => p.id === ws.focusPane)?.active || ids[0];
  app.focused = null;
  if (target) app.focusSurface(target, { claim: !app.mobile, focusView: !app.mobile });
}

function reveal(id) {
  const s = app.state?.surfaces[id];
  if (s && s.ws === app.activeWs) app.focusSurface(id, { focusView: true });
}

function focusedPane() {
  const ws = wsById(app.activeWs);
  if (!ws) return null;
  return (app.focused && paneOfSurface(ws, app.focused)) || panesOf(ws.layout).find((p) => p.id === ws.focusPane) || panesOf(ws.layout)[0];
}

function kindOfFocused() {
  return 'terminal';
}

async function newSurface(kind, opts = {}) {
  const ws = wsById(app.activeWs);
  if (!ws) return;
  const pane = opts.pane || focusedPane()?.id;
  const r = await app.conn.op('surface.new', { ws: ws.id, pane, kind, url: opts.url, file: opts.file });
  if (r?.surface) setTimeout(() => app.focusSurface(r.surface, { claim: true, focusView: true }), 30);
  return r;
}

async function split(paneId, dir, kind = 'terminal', extra = {}) {
  const ws = wsById(app.activeWs);
  if (!ws) return;
  if (app.mobile) return newSurface(kind, extra);
  const r = await app.conn.op('pane.split', { ws: ws.id, pane: paneId || focusedPane()?.id, dir, kind, ...extra });
  if (r?.surface) setTimeout(() => app.focusSurface(r.surface, { claim: true, focusView: true }), 30);
  return r;
}

function closeSurface(id) {
  const s = app.state.surfaces[id];
  if (!s) return;
  const v = app.views.get(id);
  if (v?.dirty && !confirm('Discard unsaved changes?')) return;
  // Pick the next focus before it disappears.
  const ws = wsById(s.ws);
  const p = ws && paneOfSurface(ws, id);
  if (p && app.focused === id) {
    const i = p.surfaces.indexOf(id);
    const next = p.surfaces[i + 1] || p.surfaces[i - 1];
    app.focused = null;
    if (next) setTimeout(() => app.focusSurface(next, { claim: true, focusView: true }), 40);
    else {
      const others = surfacesOf(ws).filter((x) => x !== id);
      if (others.length) setTimeout(() => app.focusSurface(others[0], { focusView: true }), 40);
    }
  }
  app.conn.op('surface.close', { id });
}

function closeWorkspace(id) {
  const ws = wsById(id);
  if (!ws) return;
  const running = surfacesOf(ws).map((sid) => app.state.live[sid]?.proc).filter(Boolean);
  if (running.length && !confirm(`Close "${ws.name}"? Running: ${running.join(', ')}`)) return;
  const idx = app.state.workspaces.indexOf(ws);
  if (id === app.activeWs) {
    const next = app.state.workspaces[idx + 1] || app.state.workspaces[idx - 1];
    if (next) activateWorkspace(next.id);
  }
  app.conn.op('ws.close', { id });
}

async function newWorkspace(opts = {}) {
  const ws = wsById(app.activeWs);
  const cwd = opts.cwd || (ws && app.state.live[app.lastTermByWs[ws.id]]?.cwd) || undefined;
  const r = await app.conn.op('ws.new', { cwd, after: app.activeWs, kind: opts.kind, url: opts.url });
  if (r?.ws) {
    await new Promise((res) => setTimeout(res, 30));
    activateWorkspace(r.ws);
  }
}

function openBrowser(url, { split: doSplit, near } = {}) {
  const ws = wsById(app.activeWs);
  if (!ws) return;
  // Reuse a browser tab already in this workspace.
  const existing = surfacesOf(ws).find((id) => app.state.surfaces[id].kind === 'browser');
  if (existing && app.views.get(existing)) {
    app.views.get(existing).navigate(url);
    app.focusSurface(existing);
    return;
  }
  const paneId = (near && paneOfSurface(ws, near)?.id) || focusedPane()?.id;
  if (doSplit) split(paneId, 'right', 'browser', { url });
  else newSurface('browser', { url, pane: paneId });
}
app.openBrowser = openBrowser;

app.openLink = (uri, fromId, ev) => {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/.test(uri);
  if (local && !ev?.altKey) openBrowser(uri, { split: !app.mobile, near: fromId });
  else window.open(uri, '_blank', 'noopener');
};

app.openEditor = (file, near) => {
  const ws = wsById(app.activeWs);
  if (!ws) return;
  const ed = surfacesOf(ws).find((id) => id !== near && app.state.surfaces[id].kind === 'editor');
  if (ed && app.views.get(ed) && !app.views.get(ed).dirty) { app.views.get(ed).open(file); app.focusSurface(ed); return; }
  const paneId = paneOfSurface(ws, near)?.id || focusedPane()?.id;
  newSurface('editor', { file, pane: paneId });
};

function openEditorSplit() {
  const ws = wsById(app.activeWs);
  const ed = ws && surfacesOf(ws).find((id) => app.state.surfaces[id].kind === 'editor');
  if (ed) { app.focusSurface(ed, { focusView: true }); app.views.get(ed)?.quickOpen(); return; }
  split(focusedPane()?.id, 'right', 'editor').then((r) => setTimeout(() => r?.surface && app.views.get(r.surface)?.quickOpen(), 300));
}

// ---------------------------------------------------------------- element picker → terminal
app.sendPicked = async (browserId, items) => {
  const s = app.state.surfaces[browserId];
  if (!s || !items?.length) return;
  const ws = wsById(s.ws);
  const terms = surfacesOf(ws).filter((id) => app.state.surfaces[id].kind === 'terminal');
  let target = [app.lastTermByWs[ws.id], ...terms].find((id) => terms.includes(id));
  if (!target) {
    const r = await app.conn.op('pane.split', { ws: ws.id, pane: paneOfSurface(ws, browserId)?.id, dir: 'left', kind: 'terminal' });
    target = r?.surface;
    await new Promise((res) => setTimeout(res, 800));
  }
  if (!target) return;
  app.conn.op('paste', { id: target, text: formatPicked(items) });
  app.focusSurface(target, { focusView: true, claim: !app.mobile });
  const it = items[0];
  app.toast(`Sent ${items.length > 1 ? items.length + ' elements' : '<' + it.tag + (it.component ? ' · ' + it.component : '') + '>'} to the terminal — now say what to change`);
};

function formatPicked(items) {
  const url = items[0].url;
  const lines = [`[Selected ${items.length > 1 ? items.length + ' elements' : 'element'} in browser at ${url}]`];
  for (const it of items) {
    lines.push(`${it.open}${it.text ? `  text: "${it.text}"` : ''}`);
    lines.push(`  selector: ${it.selector}`);
    if (it.chain?.length || it.source) lines.push(`  component: ${(it.chain || []).slice().reverse().join(' › ')}${it.source ? ` (${it.source})` : ''}`);
    const st = it.styles || {};
    lines.push(`  size ${it.size} · ${st.display} · color ${st.color} · bg ${st.background} · font ${st.font} · padding ${st.padding}`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- notifications
let audioCtx;
function chime() {
  try {
    audioCtx ||= new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, audioCtx.currentTime);
    o.frequency.setValueAtTime(1320, audioCtx.currentTime + 0.09);
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.4);
  } catch {}
}

function onNotify(m) {
  if (m.quiet) return;
  const looking = document.visibilityState === 'visible' && (document.hasFocus() || app.mobile) && app.focused === m.id;
  if (looking) {
    app.conn.op('notif.clear', { id: m.id });
    return;
  }
  const ws = wsById(m.ws);
  const title = m.title || ws?.name || 'frog';
  const body = m.body || 'Needs attention';
  if (document.visibilityState === 'visible') {
    chime();
    if (m.ws !== app.activeWs || app.focused !== m.id) app.toast(`<b>${esc(title)}</b> ${esc(body)}`, { html: true, onClick: () => app.focusSurface(m.id, { focusView: true }) });
  }
  if (desktopShell) desktopShell.notify({ title, body, id: m.id });
  else if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    const n = new Notification(title, { body, tag: m.id, silent: false });
    n.onclick = () => { focus(); app.focusSurface(m.id, { focusView: true }); n.close(); };
  }
}
desktopShell?.onNotificationClick?.((id) => app.focusSurface(id, { focusView: true, claim: true }));

function updateBadge() {
  const n = Object.values(app.state?.surfaces || {}).filter((s) => s.unread).length;
  document.title = n ? `(${n}) frog` : 'frog';
  desktopShell?.setBadge?.(n);
  const b = $('.m-badge');
  if (b) { b.textContent = n || ''; b.style.display = n ? '' : 'none'; }
  if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge?.())?.catch?.(() => {});
}

function jumpToUnread() {
  const s = Object.values(app.state.surfaces).filter((x) => x.unread).sort((a, b) => (b.notif?.ts || 0) - (a.notif?.ts || 0))[0];
  if (s) app.focusSurface(s.id, { focusView: true, claim: true });
}

addEventListener('pointerdown', () => {
  if (!desktopShell && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  if (audioCtx?.state === 'suspended') audioCtx.resume();
}, { once: true });

// ---------------------------------------------------------------- UI bits: toast, menu, sheet, palette, pair
app.toast = (msg, { html, onClick } = {}) => {
  const t = $('#toast');
  t.innerHTML = html ? msg : esc(msg);
  t.className = 'show' + (onClick ? ' clickable' : '');
  t.onclick = onClick ? () => { onClick(); t.className = ''; } : null;
  clearTimeout(app.toastT);
  app.toastT = setTimeout(() => (t.className = ''), 4500);
};

function menu(anchor, items) {
  document.querySelector('.menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = items.map((it, i) => `<button data-i="${i}">${icon(it.icon)}<span>${esc(it.label)}</span></button>`).join('');
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = r.bottom + 4 + 'px';
  m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + 'px';
  m.onclick = (e) => { const b = e.target.closest('button'); if (b) { items[+b.dataset.i].run(); m.remove(); } };
  setTimeout(() => addEventListener('pointerdown', function off(e) { if (!m.contains(e.target)) { m.remove(); removeEventListener('pointerdown', off); } }), 0);
}

function sheet({ title, body, onOpen }) {
  document.querySelector('.sheet-wrap')?.remove();
  const w = document.createElement('div');
  w.className = 'sheet-wrap';
  w.innerHTML = `<div class="sheet"><div class="sheet-head"><b>${esc(title)}</b><button class="ib close">${icon('x')}</button></div>${body}</div>`;
  document.body.appendChild(w);
  w.close = () => { w.remove(); const v = app.views.get(app.focused); if (v && !app.mobile) v.focus(); };
  w.querySelector('.close').onclick = w.close;
  w.addEventListener('pointerdown', (e) => { if (e.target === w) w.close(); });
  w.addEventListener('keydown', (e) => { if (e.key === 'Escape') w.close(); e.stopPropagation(); });
  onOpen?.(w);
  return w;
}

function fuzzy(q, s) {
  if (!q) return 1;
  q = q.toLowerCase();
  const l = s.toLowerCase();
  let i = 0, score = 0, last = -1;
  for (const ch of q) {
    const j = l.indexOf(ch, i);
    if (j < 0) return 0;
    score += j === last + 1 ? 3 : 1;
    if (j === 0 || '/._-'.includes(l[j - 1])) score += 2;
    last = j;
    i = j + 1;
  }
  const base = l.slice(l.lastIndexOf('/') + 1);
  if (base.includes(q)) score += 10;
  return score - s.length * 0.01;
}

app.palette = ({ placeholder, items, onPick }) => {
  document.querySelector('.palette-wrap')?.remove();
  const w = document.createElement('div');
  w.className = 'palette-wrap';
  w.innerHTML = `<div class="palette"><input placeholder="${esc(placeholder)}" spellcheck="false" autocapitalize="off" autocorrect="off"><div class="pl-list"></div></div>`;
  document.body.appendChild(w);
  const input = w.querySelector('input'), list = w.querySelector('.pl-list');
  let shown = [], sel = 0;
  const draw = () => {
    const q = input.value.trim();
    shown = items.map((it) => [fuzzy(q, it.label), it]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 60).map(([, it]) => it);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = shown.map((it, i) => `<div class="pl-item ${i === sel ? 'sel' : ''}" data-i="${i}">${it.icon ? icon(it.icon, 13) : ''}<span>${esc(it.label)}</span>${it.hint ? `<em>${esc(it.hint)}</em>` : ''}</div>`).join('');
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { w.remove(); };
  const pick = (it) => { close(); it && onPick(it); };
  input.oninput = () => { sel = 0; draw(); };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { sel = Math.min(sel + 1, shown.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(shown[sel]); }
    else if (e.key === 'Escape') close();
  };
  list.onclick = (e) => { const it = e.target.closest('.pl-item'); if (it) pick(shown[+it.dataset.i]); };
  w.addEventListener('pointerdown', (e) => { if (e.target === w) close(); });
  draw();
  input.focus();
};

function commandPalette() {
  const cmds = [
    ['New terminal tab', '⌘T', () => newSurface('terminal'), 'terminal'],
    ['New browser tab', '⌘B', () => newSurface('browser'), 'globe'],
    ['Open file…', '⌘P', () => openEditorSplit(), 'code'],
    ['Split right', '⌘D', () => split(focusedPane()?.id, 'right'), 'splitRight'],
    ['Split down', '⌘⇧D', () => split(focusedPane()?.id, 'down'), 'splitDown'],
    ['Browser split right', '⌘⇧B', () => split(focusedPane()?.id, 'right', 'browser'), 'globe'],
    ['Editor split right', '⌘E', () => openEditorSplit(), 'code'],
    ['New workspace', '⌘N', () => newWorkspace(), 'plus'],
    ['Jump to latest notification', '⌘⇧U', () => jumpToUnread(), 'bell'],
    ['Mark all notifications read', '', () => app.conn.op('notif.clearAll'), 'bell'],
    ['Pair a device', '', () => pairDialog(), 'phone'],
    ['Toggle sidebar', '⌘\\', () => toggleSidebar(), 'sidebar'],
    ['Find in terminal', '⌘F', () => findBar(), 'search'],
    ['Bigger text', '⌘=', () => setFont(app.fontSize + 1), 'plus'],
    ['Smaller text', '⌘-', () => setFont(app.fontSize - 1), 'plus'],
  ];
  for (const w of app.state.workspaces) cmds.push([`Go to workspace: ${w.name}`, '', () => activateWorkspace(w.id), 'layers']);
  app.palette({ placeholder: 'Run a command…', items: cmds.map(([label, hint, run, ic]) => ({ label, hint: kbd(hint), run, icon: ic })), onPick: (it) => it.run() });
}

async function pairDialog() {
  let code = '…';
  try { code = (await app.conn.op('pair.code')).code; } catch {}
  const url = `${location.protocol}//${location.host}/pair`;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  sheet({
    title: 'Pair a device',
    body: `<div class="pair-body">
      <div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>
      <div><p>On your phone (with Tailscale on), open</p><code class="pair-url">${esc(url)}</code>
      <p>and enter this code:</p><div class="pair-code">${esc(code)}</div>
      <p class="dim">Valid for 5 minutes. Devices signed into your own Tailscale account connect without a code. On iPhone, tap Share → Add to Home Screen for a full-screen app.</p></div></div>`,
  });
}

function findBar() {
  const v = app.views.get(app.focused);
  if (!v || v.kind !== 'terminal') return;
  document.querySelector('.findbar')?.remove();
  const f = document.createElement('div');
  f.className = 'findbar';
  f.innerHTML = `<input placeholder="Find" spellcheck="false"><button class="ib prev">↑</button><button class="ib next">↓</button><button class="ib close">${icon('x', 12)}</button>`;
  v.el.appendChild(f);
  const input = f.querySelector('input');
  const close = () => { v.find(''); f.remove(); v.focus(); };
  input.oninput = () => v.find(input.value, { incremental: true });
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') v.find(input.value, { prev: e.shiftKey });
    if (e.key === 'Escape') close();
  };
  f.querySelector('.prev').onclick = () => v.find(input.value, { prev: true });
  f.querySelector('.next').onclick = () => v.find(input.value);
  f.querySelector('.close').onclick = close;
  input.focus();
}

function setFont(n) {
  app.fontSize = Math.max(8, Math.min(28, n));
  localStorage.setItem('frog.font', app.fontSize);
  document.documentElement.style.setProperty('--editor-font', app.fontSize + 'px');
  for (const v of app.views.values()) v.setFontSize?.(app.fontSize);
}

function toggleSidebar() {
  document.body.classList.toggle('no-sidebar');
  setTimeout(positionViews, 0);
}

// ---------------------------------------------------------------- keyboard
function moveFocus(dir) {
  const ws = wsById(app.activeWs);
  const cur = focusedPane();
  if (!ws || !cur) return;
  const rectOf = (p) => stage.querySelector(`[data-pane="${p.id}"]`)?.getBoundingClientRect();
  const from = rectOf(cur);
  if (!from) return;
  const cx = from.left + from.width / 2, cy = from.top + from.height / 2;
  let best = null, bestD = Infinity;
  for (const p of panesOf(ws.layout)) {
    if (p === cur) continue;
    const r = rectOf(p);
    if (!r) continue;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const ok = dir === 'left' ? r.right <= from.left + 2 : dir === 'right' ? r.left >= from.right - 2 : dir === 'up' ? r.bottom <= from.top + 2 : r.top >= from.bottom - 2;
    if (!ok) continue;
    const d = Math.hypot(x - cx, y - cy);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best?.active) app.focusSurface(best.active, { focusView: true, claim: true });
}

function cycleTab(delta) {
  const ws = wsById(app.activeWs);
  const p = focusedPane();
  if (!ws || !p) return;
  const ids = app.mobile ? surfacesOf(ws) : p.surfaces;
  const i = ids.indexOf(app.focused);
  const next = ids[(i + delta + ids.length) % ids.length];
  if (next) app.focusSurface(next, { focusView: true, claim: true });
}

function cycleWorkspace(delta) {
  const list = app.state.workspaces;
  const i = list.findIndex((w) => w.id === app.activeWs);
  activateWorkspace(list[(i + delta + list.length) % list.length].id);
}

const CODE_KEYS = { BracketLeft: '[', BracketRight: ']', Backslash: '\\', Equal: '=', Minus: '-', Comma: ',' };
function codeKey(e) {
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code || '');
  if (m) return (m[1] || m[2]).toLowerCase();
  return CODE_KEYS[e.code] || (e.key.length === 1 ? e.key.toLowerCase() : e.key);
}

// Normalizes to Mac semantics. Mac: ⌘ = mod, ⇧ = sh, ⌥+arrows = move pane.
// Windows/Linux: Ctrl+Shift = mod, adding Alt = sh, Ctrl+Shift+arrows = move pane.
function handleKey(e) {
  if (e.ctrlKey && e.key === 'Tab') { cycleTab(e.shiftKey ? -1 : 1); return true; }
  let mod, sh, k;
  if (IS_MAC) {
    mod = e.metaKey;
    sh = e.shiftKey;
    k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (mod && e.altKey && e.key.startsWith('Arrow')) { moveFocus(e.key.slice(5).toLowerCase()); return true; }
  } else {
    mod = e.ctrlKey && e.shiftKey && !e.metaKey;
    sh = e.altKey;
    k = codeKey(e);
    if (mod && e.key.startsWith('Arrow')) { moveFocus(e.key.slice(5).toLowerCase()); return true; }
    if (mod && !sh && (k === 'c' || k === 'v')) return false; // terminal copy/paste
  }
  if (!mod) return false;
  const kind = app.state?.surfaces[app.focused]?.kind;
  if (/^[1-9]$/.test(k)) {
    const n = +k;
    const w = n === 9 ? app.state.workspaces.at(-1) : app.state.workspaces[n - 1];
    if (w) activateWorkspace(w.id);
    return true;
  }
  switch (k) {
    case 't': newSurface('terminal'); return true;
    case 'w': if (sh) closeWorkspace(app.activeWs); else if (app.focused) closeSurface(app.focused); return true;
    case 'n': newWorkspace(); return true;
    case 'd': split(focusedPane()?.id, sh ? 'down' : 'right'); return true;
    case 'b': if (sh) split(focusedPane()?.id, 'right', 'browser'); else newSurface('browser'); return true;
    case 'e': openEditorSplit(); return true;
    case 'p': if (sh) commandPalette(); else openEditorSplit(); return true;
    case 'k':
      if (sh || kind !== 'terminal') commandPalette();
      else app.views.get(app.focused)?.term.clear();
      return true;
    case 'u': if (sh) { jumpToUnread(); return true; } return false;
    case 'f': if (kind === 'terminal') { findBar(); return true; } return false;
    case 'l': if (kind === 'browser') { app.views.get(app.focused).focusUrl(); return true; } return false;
    case 'r': if (kind === 'browser') { app.views.get(app.focused).reload(); return true; } return true; // never reload the whole app by accident
    case 'c': if (sh && kind === 'browser') { app.views.get(app.focused).togglePick(); return true; } return false;
    case '\\': toggleSidebar(); return true;
    case '[': if (sh) { cycleTab(-1); return true; } cycleWorkspace(-1); return true;
    case ']': if (sh) { cycleTab(1); return true; } cycleWorkspace(1); return true;
    case '{': cycleTab(-1); return true;
    case '}': cycleTab(1); return true;
    case '=': case '+': setFont(app.fontSize + 1); return true;
    case '-': setFont(app.fontSize - 1); return true;
    case '0': setFont(app.mobile ? 11 : 13); return true;
  }
  return false;
}

addEventListener('keydown', (e) => {
  if (e.target.closest?.('.palette, .sheet, .findbar')) return;
  // Let the editor keep ⌘S/⌘F/⌘P etc. that it handles itself.
  if (e.target.closest?.('.cm-editor') && (e.metaKey || e.ctrlKey) && ['s', 'f', 'z', 'a', 'g'].includes(e.key.toLowerCase())) return;
  if (handleKey(e)) { e.preventDefault(); e.stopPropagation(); }
}, true);

app.handleForwardedKey = (m) => handleKey({ ...m, preventDefault() {}, stopPropagation() {}, target: document.body });
desktopShell?.onShortcut?.((m) => handleKey({ ...m, preventDefault() {}, stopPropagation() {}, target: document.body }));

// ---------------------------------------------------------------- window / viewport
addEventListener('focus', () => {
  sendFocus(true);
  const v = app.views.get(app.focused);
  if (v?.claim) v.claim();
});
addEventListener('blur', () => sendFocus(false));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { app.hiddenAt = Date.now(); sendFocus(false); return; }
  // Phone picked back up after a while: go where the action was.
  if (app.mobile && app.hiddenAt && Date.now() - app.hiddenAt > 15000) jumpToLastActive();
  sendFocus(true);
});

function onViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : innerHeight;
  document.documentElement.style.setProperty('--app-h', h + 'px');
  document.documentElement.style.setProperty('--app-top', (vv ? vv.offsetTop : 0) + 'px');
  const m = isMobile();
  if (m !== app.mobile) {
    app.mobile = m;
    document.body.classList.toggle('mobile', m);
    app.layoutSig = '';
    render();
  }
  positionViews();
}
window.visualViewport?.addEventListener('resize', onViewport);
window.visualViewport?.addEventListener('scroll', onViewport);
addEventListener('resize', onViewport);
document.body.classList.toggle('mobile', app.mobile);
document.body.classList.toggle('desktop-app', !!desktopShell);
document.documentElement.style.setProperty('--editor-font', app.fontSize + 'px');
onViewport();

// Refresh relative times in the sidebar.
setInterval(() => app.state && renderSidebar(), 30_000);
