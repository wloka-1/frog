// Injected into every page a frog browser pane loads (via the frog proxy).
// Reports navigation to the frog UI and implements the element picker.
(function () {
  if (window.__frogPicker || window.top === window) return;
  window.__frogPicker = true;
  var TARGET = window.__FROG_TARGET || location.origin;
  var parentWin = window.parent;

  function realUrl() {
    return TARGET + location.pathname + location.search + location.hash;
  }
  function post(msg) {
    msg.frog = true;
    try { parentWin.postMessage(msg, '*'); } catch (e) {}
  }
  function reportLoc() {
    post({ type: 'loc', url: realUrl(), title: document.title });
  }

  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    history[k] = function () { var r = orig.apply(this, arguments); setTimeout(reportLoc, 0); return r; };
  });
  addEventListener('popstate', reportLoc);
  addEventListener('hashchange', reportLoc);
  addEventListener('DOMContentLoaded', reportLoc);
  addEventListener('load', reportLoc);
  new MutationObserver(function () { reportLoc(); }).observe(document.querySelector('title') || document.documentElement, { childList: true, subtree: false });
  reportLoc();

  // ---------- picker ----------
  var picking = false, multi = [], box, label, hovered, lastTouched;

  function ensureOverlay() {
    if (box) return;
    box = document.createElement('div');
    box.setAttribute('data-frog', '');
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #4ade80;background:rgba(74,222,128,.12);border-radius:3px;transition:all .05s;display:none';
    label = document.createElement('div');
    label.setAttribute('data-frog', '');
    label.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#0f1f14;color:#4ade80;font:11px ui-monospace,Menlo,monospace;padding:2px 6px;border-radius:3px;white-space:nowrap;display:none;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(label);
  }

  function describeShort(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  }

  function highlight(el) {
    ensureOverlay();
    if (!el) { box.style.display = label.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    box.style.display = label.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    var c = framework(el);
    label.textContent = (c.component ? '<' + c.component + '> ' : '') + describeShort(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    var top = r.top - 22;
    label.style.top = (top < 2 ? r.bottom + 4 : top) + 'px';
    label.style.left = Math.max(2, Math.min(r.left, innerWidth - label.offsetWidth - 4)) + 'px';
  }

  function cssEscape(s) { return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }

  function selectorFor(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) { parts.unshift('#' + cssEscape(el.id)); break; }
      var part = el.tagName.toLowerCase();
      var testid = el.getAttribute('data-testid') || el.getAttribute('data-test');
      if (testid) { parts.unshift(part + '[data-testid="' + testid + '"]'); break; }
      var cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/)
        .filter(function (c) { return c && !/^(hover|focus|active)/.test(c) && c.length < 40; }).slice(0, 2);
      if (cls.length) part += '.' + cls.map(cssEscape).join('.');
      var parent = el.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === el.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
      }
      parts.unshift(part);
      el = parent;
      if (parts.length >= 6) break;
    }
    return parts.join(' > ');
  }

  // Best-effort component + source lookup for React, Vue, Svelte.
  function framework(el) {
    var out = { component: null, chain: [], source: null };
    try {
      var key = Object.keys(el).find(function (k) { return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0; });
      if (key) {
        var f = el[key];
        while (f) {
          var t = f.type;
          if (t && typeof t !== 'string') {
            var name = t.displayName || t.name || (t.render && (t.render.displayName || t.render.name));
            if (name && out.chain.length < 4 && out.chain.indexOf(name) < 0) out.chain.push(name);
          }
          if (!out.source && f._debugSource) out.source = f._debugSource.fileName.replace(/^.*?\/(src|app|components|pages)\//, '$1/') + ':' + f._debugSource.lineNumber;
          f = f.return;
        }
        out.component = out.chain[0] || null;
        return out;
      }
      var v = el.__vueParentComponent || (el.__vue__ && el.__vue__.$);
      if (v) {
        var n = v;
        while (n && out.chain.length < 4) {
          var nm = n.type && (n.type.name || n.type.__name || (n.type.__file && n.type.__file.split('/').pop()));
          if (nm) out.chain.push(nm);
          if (!out.source && n.type && n.type.__file) out.source = n.type.__file;
          n = n.parent;
        }
        out.component = out.chain[0] || null;
        return out;
      }
      var s = el;
      while (s && !s.__svelte_meta) s = s.parentElement;
      if (s && s.__svelte_meta) {
        var loc = s.__svelte_meta.loc;
        out.source = loc.file + ':' + (loc.line + 1);
        out.component = loc.file.split('/').pop();
        out.chain = [out.component];
      }
    } catch (e) {}
    return out;
  }

  function info(el) {
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var attrs = {};
    ['href', 'src', 'alt', 'role', 'type', 'name', 'placeholder', 'aria-label', 'title', 'data-testid'].forEach(function (a) {
      var v = el.getAttribute(a);
      if (v) attrs[a] = v.slice(0, 120);
    });
    var html = el.outerHTML;
    var open = html.slice(0, html.indexOf('>') + 1);
    var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    var fw = framework(el);
    return {
      url: realUrl(),
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      open: open.length > 240 ? open.slice(0, 240) + '…' : open,
      text: text.length > 120 ? text.slice(0, 120) + '…' : text,
      attrs: attrs,
      size: Math.round(r.width) + '×' + Math.round(r.height),
      styles: {
        display: cs.display, color: cs.color, background: cs.backgroundColor,
        font: cs.fontSize + ' ' + cs.fontWeight, padding: cs.padding, margin: cs.margin,
      },
      component: fw.component, chain: fw.chain, source: fw.source,
    };
  }

  function stop() {
    picking = false;
    multi = [];
    highlight(null);
    document.documentElement.style.cursor = '';
    post({ type: 'pick-state', on: false });
  }

  function targetAt(e) {
    var t = e.target;
    if (t && t.hasAttribute && t.hasAttribute('data-frog')) return hovered;
    return t;
  }

  addEventListener('mousemove', function (e) {
    if (!picking) return;
    hovered = targetAt(e);
    highlight(hovered);
  }, true);

  function swallow(e) { if (picking) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } }
  ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick', 'submit'].forEach(function (ev) {
    addEventListener(ev, function (e) {
      if (!picking) return;
      if (ev === 'touchstart') { var t = e.touches[0]; hovered = document.elementFromPoint(t.clientX, t.clientY); highlight(hovered); }
      swallow(e);
      // Touch: tap to highlight, tap the same element again to select it.
      if (ev === 'touchend' && hovered) {
        if (hovered === lastTouched) { multi.push(info(hovered)); post({ type: 'picked', items: multi }); stop(); lastTouched = null; }
        else lastTouched = hovered;
      }
    }, { capture: true, passive: false });
  });

  addEventListener('click', function (e) {
    if (!picking) return;
    swallow(e);
    var el = hovered || targetAt(e);
    if (!el) return;
    multi.push(info(el));
    if (e.shiftKey) { post({ type: 'pick-count', n: multi.length }); return; }
    post({ type: 'picked', items: multi });
    stop();
  }, true);

  addEventListener('keydown', function (e) {
    if (!picking) return;
    if (e.key === 'Escape') { swallow(e); stop(); }
    // Arrow up/down walk the DOM tree from the hovered element.
    if (e.key === 'ArrowUp' && hovered && hovered.parentElement) { swallow(e); hovered = hovered.parentElement; highlight(hovered); }
    if (e.key === 'ArrowDown' && hovered && hovered.firstElementChild) { swallow(e); hovered = hovered.firstElementChild; highlight(hovered); }
    if (e.key === 'Enter' && hovered) { swallow(e); multi.push(info(hovered)); post({ type: 'picked', items: multi }); stop(); }
  }, true);

  // Let frog's keyboard shortcuts work while focus is inside the page.
  addEventListener('keydown', function (e) {
    var mac = /Mac|iPhone|iPad/.test(navigator.platform);
    if (e.defaultPrevented || !(mac ? e.metaKey : e.ctrlKey && e.shiftKey)) return;
    var k = e.key;
    if (!mac) {
      var m = /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code || '');
      k = m ? (m[1] || m[2]).toLowerCase() : ({ BracketLeft: '[', BracketRight: ']', Backslash: '\\', Equal: '=', Minus: '-' }[e.code] || k);
      if ((k === 'c' || k === 'v') && !e.altKey) return;
    }
    var mine = /^[1-9tTwWdDnNbBpPeEjJ\\\[\]=+\-0uUrR]$/.test(k) || ((mac ? e.altKey : true) && /^Arrow/.test(k)) || ((mac ? e.shiftKey : e.altKey) && (k === 'c' || k === 'C'));
    if (!mine) return;
    e.preventDefault();
    e.stopPropagation();
    post({ type: 'key', key: k, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey });
  }, true);

  addEventListener('message', function (e) {
    var m = e.data;
    if (!m || !m.frogCmd) return;
    if (m.frogCmd === 'pick') {
      picking = !!m.on;
      if (picking) { document.documentElement.style.cursor = 'crosshair'; window.focus(); post({ type: 'pick-state', on: true }); }
      else stop();
    }
    if (m.frogCmd === 'back') history.back();
    if (m.frogCmd === 'forward') history.forward();
    if (m.frogCmd === 'reload') location.reload();
    if (m.frogCmd === 'parent' && hovered && hovered.parentElement) { hovered = hovered.parentElement; highlight(hovered); }
  });
})();
