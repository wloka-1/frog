# 🐸 frog

A lightweight terminal workspace that runs on one computer and opens anywhere. Start Claude Code (or any program) at your desk, walk away, and keep going from your phone. Same shells, same scrollback, live.

- **Vertical tabs**: one workspace per project in a left sidebar, with git branch, folder, running ports, and a ✻ when an AI agent is running
- **Attention badges**: a tab lights up when the program inside wants you (bell, OSC 9/777/99, Claude Code hooks, or an agent that just went quiet), with desktop and in-app notifications
- **Splits and tabs**: split right/down, several tabs per pane, drag tabs to rearrange or split
- **Browser panes**: open your dev server next to the terminal
- **Element picker**: click any element on the page you're building. Its selector, text, styles and React/Vue/Svelte component and source file are pasted into your terminal prompt, so you can tell Claude exactly what to change
- **Code editor pane**: file tree, quick open, syntax highlighting, live reload when the agent edits the file
- **Phone mode**: full-screen web app for iPhone/Android with an extra key row (esc, tab, ctrl, arrows) and a "Write" box that supports dictation
- **Private by default**: only reachable over [Tailscale](https://tailscale.com); your own devices get in automatically, anything else needs a pairing code

```
 your computer (server)              your desk                 your phone
┌───────────────────────┐   Tailscale  ┌──────────────┐          ┌──────────┐
│ frog server :7777     │◄────────────►│ Frog app     │          │ Safari / │
│ shells, layout, proxy │◄─────────────┼──────────────┼─────────►│ home-    │
└───────────────────────┘              └──────────────┘          │ screen   │
                                                                 └──────────┘
```

## Setup

You need **Node.js 20+**, **git**, and **Tailscale** signed into the same account on the computer and the phone.

### Windows + iPhone

1. Install the tools (PowerShell):
   ```powershell
   winget install OpenJS.NodeJS.LTS Git.Git tailscale.tailscale
   ```
   Sign into Tailscale. Install the Tailscale app on your iPhone and sign in with the **same account**.
2. Get frog and install the server so it starts when you log in:
   ```powershell
   git clone https://github.com/wloka-1/frog
   cd frog
   npm run setup
   powershell -ExecutionPolicy Bypass -File scripts\install-server.ps1
   ```
   Run that last command from an **Administrator** PowerShell once. It also adds a firewall rule that lets only Tailscale devices reach frog.
3. Install the desktop app: **Frog-Setup-…-x64.exe** from [Releases](https://github.com/wloka-1/frog/releases). It asks for the server address. Use `http://localhost:7777`.
4. On the iPhone, open Safari and go to `http://<your-pc-name>:7777`. You'll find the name in the Tailscale app. Type the `http://` and the `:7777`, or Safari won't find it. Tap **Share → Add to Home Screen**.

Shells are PowerShell (pwsh if installed). To use something else, set `FROG_SHELL`, e.g. `C:\Program Files\Git\bin\bash.exe`.

### macOS

```sh
git clone https://github.com/wloka-1/frog && cd frog
npm run setup
./scripts/install-server.sh        # launchd agent, starts at login
```

Then install **Frog-…-arm64.dmg** (Apple silicon) or **-x64.dmg** (Intel) from [Releases](https://github.com/wloka-1/frog/releases). The app isn't signed, so the first time right-click it → **Open**. Or skip the app and use any browser at `http://localhost:7777`.

The server and the desktop app can be on different machines. Run the server on an always-on Mac mini and point the app on your laptop at `http://mac-mini:7777`.

### Linux

```sh
git clone https://github.com/wloka-1/frog && cd frog
npm run setup                      # needs python3, make, g++ for node-pty
./scripts/install-server-linux.sh  # systemd --user service
```

## Using it

### Shortcuts

| Action | macOS | Windows / Linux |
|---|---|---|
| New terminal tab / close tab | ⌘T / ⌘W | Ctrl+Shift+T / Ctrl+Shift+W |
| Split right / down | ⌘D / ⌘⇧D | Ctrl+Shift+D / Ctrl+Shift+Alt+D |
| Browser tab / browser split | ⌘B / ⌘⇧B | Ctrl+Shift+B / Ctrl+Shift+Alt+B |
| Editor split, open file | ⌘E, ⌘P | Ctrl+Shift+E, Ctrl+Shift+P |
| New workspace / close workspace | ⌘N / ⌘⇧W | Ctrl+Shift+N / Ctrl+Shift+Alt+W |
| Jump to workspace 1–9 | ⌘1…9 | Ctrl+Shift+1…9 |
| Previous / next workspace | ⌘[ / ⌘] | Ctrl+Shift+[ / ] |
| Previous / next tab | ⌘⇧[ / ⌘⇧], ⌃Tab | Ctrl+Shift+Alt+[ / ], Ctrl+Tab |
| Move between panes | ⌘⌥ arrows | Ctrl+Shift+arrows |
| Jump to latest notification | ⌘⇧U | Ctrl+Shift+Alt+U |
| Element picker (browser tab) | ⌘⇧C | Ctrl+Shift+Alt+C |
| Command palette | ⌘⇧P | Ctrl+Shift+Alt+P |
| Find / clear terminal | ⌘F / ⌘K | Ctrl+Shift+F / Ctrl+Shift+K |
| Text size | ⌘= ⌘- ⌘0 | Ctrl+Shift+= - 0 |
| Toggle sidebar | ⌘\ | Ctrl+Shift+\ |
| Copy / paste in terminal | ⌘C / ⌘V | Ctrl+C (with selection) or Ctrl+Shift+C / Ctrl+V |
| Newline in Claude Code prompt | ⇧Enter | Shift+Enter |

You can also drag tabs between panes, onto a pane's edge to split, or onto a workspace in the sidebar. Double-click a workspace to rename it. Drop or paste files and images into a terminal to upload them and paste their path, which Claude Code can read.

### Element picker

1. Start your dev server in a terminal. Its port shows up as a chip in the sidebar.
2. Click the chip (or open a browser tab and type `3000`).
3. Click **Select**, then click an element. ⇧-click picks several, ↑/↓ walk to the parent/child, Esc cancels. On a phone, tap once to highlight and again to send.
4. The element's details land in the last terminal you used in that workspace. Type what you want changed.

The browser pane loads sites through a small proxy on ports 7801+, which is how frog can inspect any page you're building.

### From your phone

Opening frog on the phone jumps to the terminal you used last. Tap the terminal to resize it to the phone screen. Click back on the computer to resize it back. Use **Write** for longer prompts or dictation, and the key row for esc/tab/ctrl/arrows.

### Notifications for Claude Code

Frog notices when Claude works for a while and then goes quiet. For Claude's own messages ("needs your permission…"), install its hooks once on the server machine:

```sh
frog install-claude-hooks          # from inside a frog terminal
```

### `frog` command

Available inside every frog terminal:

```sh
frog notify "tests passed"         # badge this tab and notify your devices
frog open 3000 --right             # browser split next to this terminal
frog edit src/App.tsx:42           # open a file in the editor
frog split down
frog rename "api work"
```

## Security

frog hands out shells, so it only answers:

- the computer itself (localhost)
- Tailscale devices signed in as the server's own Tailscale account (set on first run in `~/.frog/config.json` → `allowedLogins`)
- other Tailscale devices that entered a 6-digit pairing code (**Pair device** in the sidebar)

Requests from outside the Tailscale range are refused. Traffic is plain HTTP inside Tailscale's encrypted tunnel.

## How it works

| Part | What |
|---|---|
| `server/` | Node. Each shell runs on a pty, mirrored into a headless xterm so any device can join mid-session with the exact screen. Also holds layout state, the browser proxy, and the file API. |
| `web/` | The UI (vanilla JS + xterm.js + CodeMirror, built with Vite), served by the server. |
| `desktop/` | Electron window onto a frog server, with native notifications. |
| `bin/frog` | CLI for use inside frog terminals. |

Config lives in `~/.frog/config.json` (`port`, `allowedLogins`, `proxyBasePort`, `scrollback`). Logs go to `~/.frog/server.log`.

Restarting the server keeps layout, tabs and scrollback, but running programs end.

## Development

```sh
npm run setup
npm start                          # server on :7777 (FROG_PORT to change)
npm --prefix web run dev           # optional: vite dev server for UI work
npm test                           # end-to-end smoke test (also runs in CI on macOS, Windows, Linux)
npm --prefix desktop start         # run the desktop app from source
```

## License

MIT
