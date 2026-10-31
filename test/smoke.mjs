// End-to-end smoke test: boots a real frog server in a temp dir, then drives it
// over the same websocket the UI uses. Runs in CI on macOS, Windows and Linux.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 17777 + Math.floor(Math.random() * 1000);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-test-'));
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ allowedLogins: ['nobody@example.com'], proxyBasePort: PORT + 50 }));
const isWin = process.platform === 'win32';

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, FROG_HOME: HOME, FROG_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
function check(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failed = true;
  return cond;
}
function get(url) {
  return new Promise((resolve, reject) => http.get(url, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject));
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); }
  throw new Error('timed out waiting for ' + what);
}

async function main() {
  await waitFor(() => get(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.status === 200).catch(() => false), 20000, 'server');
  check(true, 'server boots');

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const msgs = [];
  let state = null, out = '';
  const waiters = new Map();
  let req = 0;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    msgs.push(m);
    if (m.t === 'hello' || m.t === 'state') state = m.state;
    if (m.t === 'o' || m.t === 'snap') out += m.d || m.data || '';
    if (m.t === 'reply') { waiters.get(m.req)?.(m); waiters.delete(m.req); }
  });
  const op = (name, args) => new Promise((resolve) => { const id = ++req; waiters.set(id, resolve); ws.send(JSON.stringify({ t: 'op', op: name, args, req: id })); });
  await waitFor(() => state, 10000, 'hello');
  check(state.workspaces.length === 1, 'default workspace exists');

  const ws0 = state.workspaces[0];
  const termId = ws0.layout.surfaces[0];
  check(state.surfaces[termId]?.kind === 'terminal', 'default surface is a terminal');

  ws.send(JSON.stringify({ t: 'sub', id: termId }));
  ws.send(JSON.stringify({ t: 'resize', id: termId, cols: 100, rows: 30, by: 'test' }));
  await sleep(isWin ? 4000 : 1500);
  const cmd = isWin ? "Write-Output ('frog' + '-' + (40+2))" : 'echo frog-$((40+2))';
  ws.send(JSON.stringify({ t: 'i', id: termId, d: cmd + '\r' }));
  const echoed = await waitFor(() => out.includes('frog-42'), 15000, 'shell output').catch(() => false);
  check(echoed, `shell runs commands (${isWin ? 'PowerShell' : 'posix shell'})`);
  if (!echoed) console.log('--- terminal output ---\n' + out.slice(-2000));

  const sp = await op('pane.split', { ws: ws0.id, pane: ws0.layout.id, dir: 'right', kind: 'terminal' });
  await waitFor(() => state.workspaces[0].layout.type === 'split', 5000, 'split');
  check(!!sp.result?.surface, 'split right creates a terminal');

  // The CLI runs inside the frog shell, so cd to the repo first.
  ws.send(JSON.stringify({ t: 'i', id: termId, d: `cd "${ROOT}"\r` }));
  ws.send(JSON.stringify({ t: 'i', id: termId, d: (isWin ? `& "${process.execPath}" bin/frog notify smoke-notify` : `"${process.execPath}" bin/frog notify smoke-notify`) + '\r' }));
  const notified = await waitFor(() => msgs.find((m) => m.t === 'notify' && m.body === 'smoke-notify'), 15000, 'notify').catch(() => null);
  check(!!notified, 'frog notify from inside a terminal reaches clients');

  // Browser proxy: serve a page, open it through frog, expect the picker injected.
  const site = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' }); s.end('<html><head><title>t</title></head><body><button class="b">hi</button></body></html>'); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${site.address().port}/`;
  const px = await op('proxy', { url: target });
  const page = await get(`http://127.0.0.1:${px.result.port}/`);
  check(page.body.includes('/__frog/picker.js'), 'browser proxy injects the element picker');
  const picker = await get(`http://127.0.0.1:${px.result.port}/__frog/picker.js`);
  check(picker.status === 200 && picker.body.includes('frogCmd'), 'picker script is served');
  site.close();

  const tmpFile = path.join(HOME, 'hello.txt');
  fs.writeFileSync(tmpFile, 'hello');
  const read = await get(`http://127.0.0.1:${PORT}/api/fs/read?path=${encodeURIComponent(tmpFile)}`);
  check(JSON.parse(read.body).content === 'hello', 'editor file API reads files');

  await op('paste', { id: termId, text: isWin ? "Write-Output 'pasted-ok'" : "echo 'pasted-ok'" });
  ws.send(JSON.stringify({ t: 'i', id: termId, d: '\r' }));
  check(await waitFor(() => out.includes('pasted-ok'), 10000, 'paste').catch(() => false), 'paste into terminal (element picker path)');

  ws.close();
}

main()
  .catch((e) => { failed = true; console.log('FAIL', e.message); })
  .finally(() => {
    if (failed) console.log('--- server log ---\n' + serverLog.slice(-3000));
    server.kill();
    setTimeout(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} process.exit(failed ? 1 : 0); }, 800);
  });
