// File API for editor panes. Paths are absolute on the frog host.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '.turbo', '.venv', 'venv', '__pycache__', 'target', '.DS_Store', 'coverage', '.svelte-kit', '.output']);

export function expand(p) {
  if (!p) return os.homedir();
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

export async function list(dir) {
  dir = expand(dir);
  const ents = await fs.readdir(dir, { withFileTypes: true });
  return ents
    .filter((e) => e.name !== '.DS_Store')
    .map((e) => ({ name: e.name, dir: e.isDirectory() || (e.isSymbolicLink() && isDirSync(path.join(dir, e.name))), path: path.join(dir, e.name) }))
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
}

function isDirSync(p) { try { return fss.statSync(p).isDirectory(); } catch { return false; } }

export async function read(file) {
  file = expand(file);
  const st = await fs.stat(file);
  if (st.size > 5 * 1024 * 1024) throw Object.assign(new Error('File too large (>5MB)'), { status: 413 });
  const buf = await fs.readFile(file);
  if (buf.subarray(0, 8000).includes(0)) throw Object.assign(new Error('Binary file'), { status: 415 });
  return { path: file, content: buf.toString('utf8'), mtime: st.mtimeMs };
}

export async function write(file, content, expectMtime) {
  file = expand(file);
  if (expectMtime) {
    try {
      const st = await fs.stat(file);
      if (Math.abs(st.mtimeMs - expectMtime) > 1) throw Object.assign(new Error('File changed on disk'), { status: 409, mtime: st.mtimeMs });
    } catch (e) { if (e.status) throw e; }
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  const st = await fs.stat(file);
  return { path: file, mtime: st.mtimeMs };
}

export async function stat(file) {
  try { const st = await fs.stat(expand(file)); return { mtime: st.mtimeMs, size: st.size, dir: st.isDirectory() }; } catch { return null; }
}

// All files under a root for quick-open. Uses git when available (respects .gitignore).
export function files(root) {
  root = expand(root);
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 5000 }, async (err, stdout) => {
      if (!err && stdout.trim()) return resolve({ root, files: stdout.split('\n').filter(Boolean).slice(0, 50000) });
      const out = [];
      async function walk(d, rel, depth) {
        if (out.length > 20000 || depth > 8) return;
        let ents;
        try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (IGNORE.has(e.name)) continue;
          const r = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) await walk(path.join(d, e.name), r, depth + 1);
          else out.push(r);
        }
      }
      await walk(root, '', 0);
      resolve({ root, files: out });
    });
  });
}

export function gitBranch(dir) {
  let d = dir;
  for (let i = 0; i < 30 && d; i++) {
    const g = path.join(d, '.git');
    try {
      let gitDir = g;
      const st = fss.statSync(g);
      if (st.isFile()) {
        const m = fss.readFileSync(g, 'utf8').match(/gitdir:\s*(.+)/);
        if (m) gitDir = path.resolve(d, m[1].trim());
      }
      const head = fss.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      const m = head.match(/^ref: refs\/heads\/(.+)$/);
      return { root: d, branch: m ? m[1] : head.slice(0, 7) };
    } catch {}
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}
