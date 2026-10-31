// OS differences: default shell, and "live info" (cwd, running program,
// listening ports) for each terminal. macOS/Linux use ps + lsof (or /proc);
// Windows uses one PowerShell CIM query.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

function onPath(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of isWin ? ['.exe', '.cmd', ''] : ['']) {
      const p = path.join(dir, bin + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export function defaultShell() {
  if (process.env.FROG_SHELL) return process.env.FROG_SHELL;
  if (isWin) return onPath('pwsh') || 'powershell.exe';
  return os.userInfo().shell || process.env.SHELL || (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash');
}

// PowerShell doesn't report its cwd, so teach its prompt to emit the
// Windows Terminal cwd sequence (OSC 9;9) after the user's profile loads.
const PWSH_HOOK = '$__frogPrompt = $function:prompt; function global:prompt { $p = $executionContext.SessionState.Path.CurrentLocation; if ($p.Provider.Name -eq "FileSystem") { [Console]::Write("$([char]27)]9;9;`"$($p.ProviderPath)`"$([char]7)") }; & $__frogPrompt }';

export function shellArgs(shell) {
  const base = path.basename(shell).toLowerCase();
  if (/^(pwsh|powershell)(\.exe)?$/.test(base)) return ['-NoLogo', '-NoExit', '-Command', PWSH_HOOK];
  if (/^cmd(\.exe)?$/.test(base)) return [];
  if (isWin) return ['--login', '-i']; // git-bash / wsl-ish shells
  return ['-l'];
}

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (e, out) => resolve(out || '')));
}

// Returns { cwdByPid, parent, procs: {pid: {comm, fg}}, portsByPid }
export async function snapshot(shellPids, ignorePort) {
  if (isWin) return winSnapshot(ignorePort);
  const [psOut, lsnOut, cwdOut] = await Promise.all([
    run('ps', ['-axo', 'pid=,ppid=,stat=,comm=']),
    run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']),
    isMac && shellPids.length ? run('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', shellPids.join(',')]) : Promise.resolve(''),
  ]);
  const cwdByPid = {};
  if (isMac) {
    let cur = null;
    for (const line of cwdOut.split('\n')) {
      if (line[0] === 'p') cur = +line.slice(1);
      else if (line[0] === 'n' && cur) cwdByPid[cur] = line.slice(1);
    }
  } else {
    for (const pid of shellPids) { try { cwdByPid[pid] = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {} }
  }
  const parent = {}, procs = {};
  for (const line of psOut.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    parent[+m[1]] = +m[2];
    procs[+m[1]] = { comm: path.basename(m[4]), fg: m[3].includes('+') };
  }
  const portsByPid = {};
  let cur = null;
  for (const line of lsnOut.split('\n')) {
    if (line[0] === 'p') cur = +line.slice(1);
    else if (line[0] === 'n' && cur) {
      const port = +line.slice(line.lastIndexOf(':') + 1);
      if (port && !ignorePort(port)) (portsByPid[cur] ||= new Set()).add(port);
    }
  }
  return { cwdByPid, parent, procs, portsByPid };
}

const WIN_QUERY = '$ErrorActionPreference="SilentlyContinue";' +
  '$p=Get-CimInstance Win32_Process | ForEach-Object { "P`t$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)" };' +
  '$l=Get-NetTCPConnection -State Listen | ForEach-Object { "L`t$($_.OwningProcess)`t$($_.LocalPort)" };' +
  '$p; $l';
const WIN_NOISE = /^(conhost|openconsole|wslhost|cmd)\.exe$/i;

async function winSnapshot(ignorePort) {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_QUERY], 10000);
  const parent = {}, procs = {}, portsByPid = {};
  for (const line of out.split(/\r?\n/)) {
    const f = line.split('\t');
    if (f[0] === 'P') {
      parent[+f[1]] = +f[2];
      // Windows has no foreground flag: any real child of the shell counts.
      procs[+f[1]] = { comm: f[3].replace(/\.exe$/i, ''), fg: !WIN_NOISE.test(f[3]) };
    } else if (f[0] === 'L') {
      const port = +f[2];
      if (port && !ignorePort(port)) (portsByPid[+f[1]] ||= new Set()).add(port);
    }
  }
  return { cwdByPid: {}, parent, procs, portsByPid };
}

export const liveInterval = isWin ? 5000 : 2500;
