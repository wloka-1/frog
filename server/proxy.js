// Browser panes load sites through a per-origin reverse proxy on its own port.
// The proxy strips frame-blocking headers and injects picker.js, which talks to
// the frog UI with postMessage. Websockets (HMR) pass straight through.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';

export function createProxyManager({ host, basePort = 7801, auth, staticDir }) {
  const byOrigin = new Map(); // origin -> { port, server }
  const pickerPath = path.join(staticDir, 'picker.js');

  function originOf(url) {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  }

  async function ensure(targetUrl) {
    const origin = originOf(targetUrl);
    const hit = byOrigin.get(origin);
    if (hit) return hit.port;
    let port = basePort + byOrigin.size;
    for (;;) {
      try {
        const server = await listen(origin, port);
        byOrigin.set(origin, { port, server });
        return port;
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
        port++;
      }
    }
  }

  function listen(origin, port) {
    const target = new URL(origin);
    const secure = target.protocol === 'https:';
    const lib = secure ? https : http;
    const targetPort = target.port || (secure ? 443 : 80);
    const loopbackTarget = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(target.hostname);
    // localhost may resolve to ::1 while the dev server listens on 127.0.0.1 (or vice versa).
    let connectHost = target.hostname === '0.0.0.0' ? '127.0.0.1' : target.hostname.replace(/^\[|\]$/g, '');

    const server = http.createServer(async (req, res) => {
      const a = await auth.check(req);
      if (!a.ok) { res.writeHead(403); res.end('frog: not authorized'); return; }

      if (req.url.startsWith('/__frog/picker.js')) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        fs.createReadStream(pickerPath).pipe(res);
        return;
      }

      const headers = { ...req.headers, host: target.host, 'accept-encoding': 'identity' };
      if (headers.origin) headers.origin = origin;
      if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, origin);
      if (headers.cookie) headers.cookie = headers.cookie.split(/;\s*/).filter((c) => !c.startsWith('frog_token=')).join('; ');

      const send = (hostname) => lib.request({
        hostname, port: targetPort, path: req.url, method: req.method, headers,
        rejectUnauthorized: false, servername: secure ? target.hostname : undefined,
      });
      let up = send(connectHost);
      const onResponse = (pr) => {
        const h = { ...pr.headers };
        delete h['content-security-policy'];
        delete h['content-security-policy-report-only'];
        delete h['x-frame-options'];
        delete h['cross-origin-opener-policy'];
        delete h['cross-origin-embedder-policy'];
        delete h['strict-transport-security'];
        if (h.location) h.location = h.location.replace(origin, '');
        if (h['set-cookie']) {
          h['set-cookie'] = [].concat(h['set-cookie']).map((c) =>
            c.replace(/;\s*domain=[^;]*/gi, '').replace(/;\s*secure/gi, '').replace(/samesite=none/gi, 'SameSite=Lax'));
        }
        const type = h['content-type'] || '';
        if (type.includes('text/html') && req.method !== 'HEAD') {
          const chunks = [];
          pr.on('data', (c) => chunks.push(c));
          pr.on('end', () => {
            let body = Buffer.concat(chunks).toString('utf8');
            const inject = `<script>window.__FROG_TARGET=${JSON.stringify(origin)}</script><script src="/__frog/picker.js"></script>`;
            const m = body.match(/<head[^>]*>/i);
            body = m ? body.replace(m[0], m[0] + inject) : inject + body;
            delete h['content-length'];
            delete h['transfer-encoding'];
            h['content-length'] = Buffer.byteLength(body);
            res.writeHead(pr.statusCode, h);
            res.end(body);
          });
        } else {
          res.writeHead(pr.statusCode, h);
          pr.pipe(res);
        }
      };
      up.on('response', onResponse);
      up.on('error', (err) => {
        if (loopbackTarget && !up.retried && (err.code === 'ECONNREFUSED' || err.code === 'EADDRNOTAVAIL')) {
          const alt = connectHost === '::1' ? '127.0.0.1' : '::1';
          up = send(alt);
          up.retried = true;
          up.on('response', (pr) => { connectHost = alt; onResponse(pr); });
          up.on('error', (e2) => fail(res, e2));
          req.pipe(up);
          return;
        }
        fail(res, err);
      });
      req.pipe(up);
    });

    server.on('upgrade', async (req, socket, head) => {
      const a = await auth.check(req);
      if (!a.ok) { socket.destroy(); return; }
      const conn = secure
        ? tls.connect({ host: connectHost, port: targetPort, servername: target.hostname, rejectUnauthorized: false })
        : net.connect({ host: connectHost, port: targetPort });
      conn.on(secure ? 'secureConnect' : 'connect', () => {
        const hdrs = { ...req.headers, host: target.host };
        if (hdrs.origin) hdrs.origin = origin;
        let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(hdrs)) for (const vv of [].concat(v)) raw += `${k}: ${vv}\r\n`;
        conn.write(raw + '\r\n');
        if (head?.length) conn.write(head);
        conn.pipe(socket);
        socket.pipe(conn);
      });
      conn.on('error', () => socket.destroy());
      socket.on('error', () => conn.destroy());
    });

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server));
    });
  }

  function fail(res, err) {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end(`<!doctype html><meta name=viewport content="width=device-width"><body style="font:14px -apple-system,system-ui;background:#111;color:#aaa;display:grid;place-items:center;height:90vh"><div><b style="color:#eee">Can't reach this page</b><p>${String(err.code || err.message)}</p><p>Is the dev server running?</p><button onclick="location.reload()">Retry</button></div><script>setTimeout(()=>location.reload(),3000)</script>`);
  }

  return { ensure, list: () => [...byOrigin].map(([o, v]) => ({ origin: o, port: v.port })) };
}
