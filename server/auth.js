// Access control. Frog hands out shells, so only these callers get in:
//   1. loopback (the frog CLI, hooks)
//   2. tailnet peers whose Tailscale owner is in config.allowedLogins (checked with `tailscale whois`)
//   3. tailnet peers holding a token issued by pairing with a 6-digit code
// Anything off the tailnet is refused outright.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TS_CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
];

export function normalizeIp(ip = '') {
  return ip.replace(/^::ffff:/, '');
}

export function isLoopback(ip) {
  ip = normalizeIp(ip);
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

export function isTailnet(ip) {
  ip = normalizeIp(ip);
  if (ip.toLowerCase().startsWith('fd7a:115c:a1e0:')) return true;
  const m = ip.match(/^100\.(\d+)\./);
  return !!m && +m[1] >= 64 && +m[1] <= 127;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createAuth({ config, dataDir }) {
  const tsBin = TS_CANDIDATES.find((p) => fs.existsSync(p)) || 'tailscale';
  const tokensFile = path.join(dataDir, 'tokens.json');
  let tokens = {};
  try { tokens = JSON.parse(fs.readFileSync(tokensFile, 'utf8')); } catch {}
  const saveTokens = () => fs.writeFileSync(tokensFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });

  const whoisCache = new Map(); // ip -> { login, at }
  const codes = new Map(); // code -> expiresAt
  const failures = new Map(); // ip -> { n, at }

  function whois(ip) {
    ip = normalizeIp(ip);
    const hit = whoisCache.get(ip);
    if (hit && Date.now() - hit.at < 10 * 60_000) return Promise.resolve(hit);
    return new Promise((resolve) => {
      execFile(tsBin, ['whois', '--json', ip], { timeout: 4000, windowsHide: true }, (err, stdout) => {
        let info = { login: null, device: null, at: Date.now() };
        if (!err) {
          try {
            const j = JSON.parse(stdout);
            info.login = j?.UserProfile?.LoginName || null;
            info.device = j?.Node?.ComputedName || j?.Node?.Name || null;
          } catch {}
        }
        whoisCache.set(ip, info);
        resolve(info);
      });
    });
  }

  async function check(req) {
    const ip = normalizeIp(req.socket.remoteAddress);
    if (isLoopback(ip)) return { ok: true, who: 'local' };
    if (!isTailnet(ip) && !config.allowLan) return { ok: false, reason: 'not-tailnet' };
    const token = parseCookies(req.headers.cookie).frog_token || req.headers['x-frog-token'];
    if (token && tokens[token]) return { ok: true, who: tokens[token].name || 'paired' };
    const info = await whois(ip);
    if (info.login && config.allowedLogins.includes(info.login)) return { ok: true, who: info.login, device: info.device };
    return { ok: false, reason: 'pair', login: info.login };
  }

  function newCode() {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    codes.set(code, Date.now() + 5 * 60_000);
    return code;
  }

  function redeem(req, code, name) {
    const ip = normalizeIp(req.socket.remoteAddress);
    const f = failures.get(ip) || { n: 0, at: Date.now() };
    if (Date.now() - f.at > 10 * 60_000) { f.n = 0; f.at = Date.now(); }
    if (f.n >= 8) return null;
    const exp = codes.get(String(code).trim());
    if (!exp || exp < Date.now()) { f.n++; failures.set(ip, f); return null; }
    codes.delete(String(code).trim());
    const token = crypto.randomBytes(24).toString('base64url');
    tokens[token] = { name: name || 'device', created: new Date().toISOString(), ip };
    saveTokens();
    return token;
  }

  // The Tailscale account this machine is signed into. Used as the default
  // allow-list, so "your devices" work with zero config.
  function ownLogin() {
    return new Promise((resolve) => {
      execFile(tsBin, ['status', '--json'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        try {
          const j = JSON.parse(stdout);
          resolve(j.User?.[String(j.Self?.UserID)]?.LoginName || null);
        } catch { resolve(null); }
      });
    });
  }

  return { check, whois, newCode, redeem, ownLogin, tsBin };
}
