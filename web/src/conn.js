// WebSocket link to the frog server with auto-reconnect and request/reply.
export function connect({ onMessage, onStatus }) {
  let ws = null;
  let backoff = 300;
  let reqId = 0;
  const pending = new Map();
  const queue = [];
  let timer = null;

  function open() {
    clearTimeout(timer);
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    ws = new WebSocket(url);
    onStatus('connecting');
    ws.onopen = () => {
      backoff = 300;
      onStatus('open');
      while (queue.length) ws.send(queue.shift());
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'reply') {
        const p = pending.get(m.req);
        if (p) { pending.delete(m.req); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); }
        return;
      }
      onMessage(m);
    };
    ws.onclose = (e) => {
      onStatus('closed', e.code);
      for (const p of pending.values()) p.reject(new Error('disconnected'));
      pending.clear();
      timer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 1.7, 4000);
    };
    ws.onerror = () => {};
  }

  function send(m) {
    const s = JSON.stringify(m);
    if (ws && ws.readyState === 1) ws.send(s);
    else if (m.t === 'op') queue.push(s);
  }

  function op(name, args) {
    const req = ++reqId;
    return new Promise((resolve, reject) => {
      pending.set(req, { resolve, reject });
      send({ t: 'op', op: name, args, req });
      setTimeout(() => { if (pending.delete(req)) reject(new Error('timeout')); }, 15000);
    });
  }

  // iOS freezes background tabs; reconnect the moment we come back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!ws || ws.readyState > 1)) { backoff = 300; open(); }
  });
  addEventListener('online', () => { backoff = 300; open(); });
  addEventListener('pageshow', () => { if (!ws || ws.readyState > 1) open(); });

  open();
  return { send, op, get open() { return ws && ws.readyState === 1; }, reconnect: () => { try { ws.close(); } catch {} } };
}
