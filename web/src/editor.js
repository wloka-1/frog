// An editor surface: file tree + CodeMirror, reading/writing files on the frog host.
// Picks up on-disk changes (e.g. Claude editing the file) automatically.
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, dropCursor } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { closeBrackets, autocompletion, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle, foldKeymap } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { icon } from './icons.js';

const LANGS = {
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  mjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  cjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  ts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  scss: () => import('@codemirror/lang-css').then((m) => m.css()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  vue: () => import('@codemirror/lang-html').then((m) => m.html()),
  svelte: () => import('@codemirror/lang-html').then((m) => m.html()),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  mdx: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  py: () => import('@codemirror/lang-python').then((m) => m.python()),
  rs: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  yml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
};

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-font, 13px)', backgroundColor: '#0d1110' },
  '.cm-scroller': { fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace', lineHeight: '1.5' },
  '.cm-gutters': { backgroundColor: '#0d1110', borderRight: '1px solid #1c2521', color: '#46534c' },
  '.cm-activeLine': { backgroundColor: '#141c18' },
  '.cm-activeLineGutter': { backgroundColor: '#141c18', color: '#9fb0a6' },
  '&.cm-focused .cm-cursor': { borderLeftColor: '#4ade80' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#2f5a3d !important' },
}, { dark: true });

async function api(p, opts) {
  const r = await fetch(p, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, mtime: j.mtime });
  return j;
}

export class EditorViewSurface {
  constructor(app, surface) {
    this.app = app;
    this.id = surface.id;
    this.kind = 'editor';
    this.file = '';
    this.mtime = 0;
    this.dirty = false;
    this.root = surface.root || app.state?.home || '~';
    this.expanded = new Set([this.root]);
    this.lang = new Compartment();

    this.el = document.createElement('div');
    this.el.className = 'view editor-view';
    this.el.innerHTML = `
      <div class="tree"><div class="tree-head"><span class="tree-root"></span></div><div class="tree-body"></div></div>
      <div class="ed-main">
        <div class="bar ed-bar">
          <button class="ib tree-toggle" title="Toggle files">${icon('sidebar')}</button>
          <div class="ed-path"></div>
          <span class="ed-dirty" title="Unsaved changes"></span>
          <button class="ib quick" title="Open file (⌘P)">${icon('search')}</button>
          <button class="ib save" title="Save (⌘S)">${icon('save')}</button>
        </div>
        <div class="ed-banner"></div>
        <div class="cm-host"><div class="ed-empty">Pick a file on the left or press ⌘P</div></div>
      </div>`;
    this.host = this.el.querySelector('.cm-host');
    this.treeBody = this.el.querySelector('.tree-body');
    this.banner = this.el.querySelector('.ed-banner');
    this.el.querySelector('.tree-toggle').onclick = () => this.el.classList.toggle('no-tree');
    this.el.querySelector('.quick').onclick = () => this.quickOpen();
    this.el.querySelector('.save').onclick = () => this.save();
    this.el.addEventListener('mousedown', () => app.focusSurface(this.id), true);
    this.el.addEventListener('touchstart', () => app.focusSurface(this.id), { capture: true, passive: true });
    if (app.mobile) this.el.classList.add('no-tree');

    this.view = new EditorView({
      parent: this.host,
      state: this.makeState(''),
    });
    this.renderTree();
    this.sync(surface);
    this.poll = setInterval(() => this.checkDisk(), 2000);
  }

  makeState(doc) {
    return EditorState.create({
      doc,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), foldGutter(), history(), drawSelection(), dropCursor(),
        EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
        autocompletion(), rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark, theme,
        keymap.of([
          { key: 'Mod-s', run: () => { this.save(); return true; } },
          { key: 'Mod-p', run: () => { this.quickOpen(); return true; } },
          indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap,
        ]),
        this.lang.of([]),
        EditorView.updateListener.of((u) => { if (u.docChanged && !this.loading) this.setDirty(true); }),
      ],
    });
  }

  sync(surface) {
    if (surface.root && surface.root !== this.root) { this.root = surface.root; this.expanded = new Set([this.root]); this.renderTree(); }
    if (surface.file && surface.file !== this.file) this.open(surface.file, { line: surface.line, fromServer: true });
  }

  async open(file, { line, fromServer } = {}) {
    if (this.dirty && file !== this.file) await this.save();
    try {
      const st = await api('/api/fs/stat?path=' + encodeURIComponent(file));
      if (st?.dir) { this.root = file; this.expanded = new Set([file]); this.renderTree(); return; }
      const r = await api('/api/fs/read?path=' + encodeURIComponent(file));
      this.file = r.path;
      this.mtime = r.mtime;
      this.loading = true;
      this.view.setState(this.makeState(r.content));
      this.loading = false;
      this.setDirty(false);
      this.host.querySelector('.ed-empty')?.remove();
      this.el.querySelector('.ed-path').textContent = this.app.shortPath(r.path);
      this.el.querySelector('.ed-path').title = r.path;
      const ext = r.path.split('.').pop().toLowerCase();
      const loader = LANGS[ext];
      if (loader) loader().then((l) => this.view.dispatch({ effects: this.lang.reconfigure(l) })).catch(() => {});
      if (line) this.gotoLine(line);
      if (!fromServer) this.app.conn.op('surface.update', { id: this.id, file: r.path, line: line || 0 });
      this.renderTree();
      this.banner.className = 'ed-banner';
    } catch (e) {
      this.app.toast(`Can't open ${file}: ${e.message}`);
    }
  }

  gotoLine(n) {
    const doc = this.view.state.doc;
    const l = doc.line(Math.max(1, Math.min(n, doc.lines)));
    this.view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
  }

  setDirty(d) {
    this.dirty = d;
    this.el.classList.toggle('dirty', d);
  }

  async save(force) {
    if (!this.file) return;
    try {
      const r = await api('/api/fs/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: this.file, content: this.view.state.doc.toString(), mtime: force ? undefined : this.mtime }) });
      this.mtime = r.mtime;
      this.setDirty(false);
      this.banner.className = 'ed-banner';
    } catch (e) {
      if (e.status === 409) this.showConflict();
      else this.app.toast('Save failed: ' + e.message);
    }
  }

  showConflict() {
    this.banner.className = 'ed-banner show';
    this.banner.innerHTML = `File changed on disk. <button class="reload">Load disk version</button><button class="overwrite">Keep mine</button>`;
    this.banner.querySelector('.reload').onclick = () => { this.setDirty(false); this.reloadFromDisk(); };
    this.banner.querySelector('.overwrite').onclick = () => this.save(true);
  }

  async reloadFromDisk() {
    const r = await api('/api/fs/read?path=' + encodeURIComponent(this.file));
    const sel = this.view.state.selection.main.head;
    const scroll = this.view.scrollDOM.scrollTop;
    this.loading = true;
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: r.content }, selection: { anchor: Math.min(sel, r.content.length) } });
    this.loading = false;
    this.view.scrollDOM.scrollTop = scroll;
    this.mtime = r.mtime;
    this.setDirty(false);
    this.banner.className = 'ed-banner';
  }

  async checkDisk() {
    if (!this.visible || !this.file || document.visibilityState !== 'visible') return;
    const st = await api('/api/fs/stat?path=' + encodeURIComponent(this.file)).catch(() => null);
    if (!st || Math.abs(st.mtime - this.mtime) < 1) return;
    if (this.dirty) this.showConflict();
    else this.reloadFromDisk();
  }

  async renderTree() {
    this.el.querySelector('.tree-root').textContent = this.app.shortPath(this.root);
    const frag = document.createDocumentFragment();
    const walk = async (dir, depth) => {
      let entries = [];
      try { entries = (await api('/api/fs/list?path=' + encodeURIComponent(dir))).entries; } catch { return; }
      for (const e of entries) {
        if (e.name === '.git') continue;
        const row = document.createElement('div');
        row.className = 'tree-row' + (e.dir ? ' dir' : '') + (e.path === this.file ? ' current' : '') + (e.name.startsWith('.') ? ' hidden' : '');
        row.style.paddingLeft = 8 + depth * 12 + 'px';
        const open = this.expanded.has(e.path);
        row.innerHTML = (e.dir ? `<span class="tw ${open ? 'open' : ''}">${icon('chevron', 11)}</span>` : '<span class="tw"></span>') + `<span class="tn"></span>`;
        row.querySelector('.tn').textContent = e.name;
        row.title = e.path;
        row.onclick = (ev) => {
          if (e.dir) { open ? this.expanded.delete(e.path) : this.expanded.add(e.path); this.renderTree(); }
          else if (ev.metaKey) this.app.openEditor(e.path, this.id);
          else { this.open(e.path); if (this.app.mobile) this.el.classList.add('no-tree'); }
        };
        frag.appendChild(row);
        if (e.dir && open) await walk(e.path, depth + 1);
      }
    };
    await walk(this.root, 0);
    this.treeBody.replaceChildren(frag);
  }

  async quickOpen() {
    const { root, files } = await api('/api/fs/files?path=' + encodeURIComponent(this.root));
    this.app.palette({
      placeholder: 'Open file in ' + this.app.shortPath(root),
      items: files.map((f) => ({ label: f, value: root + '/' + f })),
      onPick: (it) => this.open(it.value),
    });
  }

  setVisible(v) { this.visible = v; if (v) { this.view.requestMeasure(); this.checkDisk(); } }
  focus() { this.view.focus(); }
  blur() {}
  dispose() { clearInterval(this.poll); this.view.destroy(); this.el.remove(); }
}
