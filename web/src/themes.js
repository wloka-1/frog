// Themes: one object drives the UI (CSS variables), the code editor (via the same
// variables, so it restyles live) and xterm (which needs its palette pushed in).
// Add a theme by adding an entry to THEMES. The popular terminal themes (Catppuccin,
// Tokyo Night, …) are generated into themes-ghostty.js.
import { GHOSTTY_THEMES } from './themes-ghostty.js';

const base = {
  // syntax (editor)
  synKeyword: '#c084fc', synString: '#86efac', synNumber: '#fbbf24', synComment: '#56655d',
  synFunction: '#60a5fa', synType: '#f0a46b', synVariable: '#d7e0da', synProperty: '#7dd3fc',
  synOperator: '#9fb0a6', synTag: '#f87171', synAttr: '#fbbf24', synHeading: '#4ade80',
  synInvalid: '#ef4444', synMeta: '#7d8b83',
};

export const THEMES = {
  frog: {
    name: 'Frog', dark: true,
    ui: {
      bg: '#0d1110', bg2: '#111715', bg3: '#161e1b', line: '#1f2925', line2: '#2a3631',
      fg: '#d7e0da', fg2: '#c3cec7', dim: '#7d8b83', dimmer: '#4f5c55',
      accent: '#4ade80', accentDim: '#1d3a27', accentHover: '#24502f', onAccent: '#062312',
      warn: '#60a5fa', warnRgb: '96,165,250', notif: '#b9d3ff', proc: '#f0a46b', git: '#9fc8a9',
      selection: '#2f5a3d', activeLine: '#141c18', gutter: '#46534c', gutterActive: '#9fb0a6',
      toast: '#18221d', shadow: 'rgba(0,0,0,.45)',
      bannerBg: '#2b2410', bannerFg: '#fde68a', bannerBtn: '#463a12',
    },
    syn: { ...base },
    term: {
      black: '#1b2320', red: '#f87171', green: '#4ade80', yellow: '#facc15',
      blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d7e0da',
      brightBlack: '#5b6b63', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047',
      brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
    },
  },

  pond: {
    name: 'Midnight Pond', dark: true,
    ui: {
      bg: '#0b1020', bg2: '#0f1529', bg3: '#151c35', line: '#1e2744', line2: '#2a355a',
      fg: '#d6def5', fg2: '#bcc6e4', dim: '#7b86a8', dimmer: '#4d5778',
      accent: '#5eead4', accentDim: '#123a3c', accentHover: '#18504f', onAccent: '#04201d',
      warn: '#f9a8d4', warnRgb: '249,168,212', notif: '#fbcfe8', proc: '#fdba74', git: '#99f6e4',
      selection: '#24406a', activeLine: '#121a31', gutter: '#3f4a6d', gutterActive: '#a5b1d6',
      toast: '#141b33', shadow: 'rgba(0,0,0,.5)',
      bannerBg: '#2a2140', bannerFg: '#e9d5ff', bannerBtn: '#41325f',
    },
    syn: {
      ...base, synKeyword: '#f472b6', synString: '#5eead4', synNumber: '#fdba74', synComment: '#4d5778',
      synFunction: '#93c5fd', synType: '#c4b5fd', synVariable: '#d6def5', synProperty: '#a5f3fc',
      synOperator: '#94a3c8', synTag: '#f472b6', synAttr: '#c4b5fd', synHeading: '#5eead4', synMeta: '#7b86a8',
    },
    term: {
      black: '#1a2140', red: '#fb7185', green: '#5eead4', yellow: '#fde68a',
      blue: '#93c5fd', magenta: '#f472b6', cyan: '#67e8f9', white: '#d6def5',
      brightBlack: '#56608a', brightRed: '#fda4af', brightGreen: '#99f6e4', brightYellow: '#fef3c7',
      brightBlue: '#bfdbfe', brightMagenta: '#f9a8d4', brightCyan: '#a5f3fc', brightWhite: '#ffffff',
    },
  },

  bog: {
    name: 'Bog', dark: true,
    ui: {
      bg: '#14120e', bg2: '#1a1712', bg3: '#221e17', line: '#2c271e', line2: '#3a3428',
      fg: '#e6dccb', fg2: '#d0c6b4', dim: '#958a76', dimmer: '#62594a',
      accent: '#a3c26b', accentDim: '#2c3519', accentHover: '#3a4820', onAccent: '#141a07',
      warn: '#e8a85c', warnRgb: '232,168,92', notif: '#f5d0a0', proc: '#e8a85c', git: '#b8c98f',
      selection: '#45422a', activeLine: '#1d1a14', gutter: '#5a5244', gutterActive: '#bfb39c',
      toast: '#221e17', shadow: 'rgba(0,0,0,.5)',
      bannerBg: '#33240f', bannerFg: '#f5d0a0', bannerBtn: '#4d3816',
    },
    syn: {
      ...base, synKeyword: '#d98a6c', synString: '#a3c26b', synNumber: '#d8b35a', synComment: '#6b6253',
      synFunction: '#8fb8c9', synType: '#d8b35a', synVariable: '#e6dccb', synProperty: '#a8c4b0',
      synOperator: '#b0a58f', synTag: '#d98a6c', synAttr: '#d8b35a', synHeading: '#a3c26b', synMeta: '#958a76',
    },
    term: {
      black: '#262119', red: '#d9705a', green: '#a3c26b', yellow: '#d8b35a',
      blue: '#7fa8bf', magenta: '#c08aa8', cyan: '#8bbfae', white: '#e6dccb',
      brightBlack: '#6b6253', brightRed: '#eb9480', brightGreen: '#c2db92', brightYellow: '#ecd08a',
      brightBlue: '#a6c6d8', brightMagenta: '#d8adc4', brightCyan: '#b0dacb', brightWhite: '#fbf6ec',
    },
  },

  lilypad: {
    name: 'Lily Pad (light)', dark: false,
    ui: {
      bg: '#fbfcfa', bg2: '#f2f5f1', bg3: '#e8ede6', line: '#dde4da', line2: '#cad4c6',
      fg: '#1d2620', fg2: '#2f3a33', dim: '#66736b', dimmer: '#97a39b',
      accent: '#15803d', accentDim: '#d6efdc', accentHover: '#c2e6cb', onAccent: '#ffffff',
      warn: '#2563eb', warnRgb: '37,99,235', notif: '#1d4ed8', proc: '#c2410c', git: '#3f7a50',
      selection: '#bfe3c8', activeLine: '#f0f5ee', gutter: '#a3ada6', gutterActive: '#3f4a43',
      toast: '#ffffff', shadow: 'rgba(30,45,35,.18)',
      bannerBg: '#fef3c7', bannerFg: '#78350f', bannerBtn: '#fde68a',
    },
    syn: {
      ...base, synKeyword: '#9333ea', synString: '#15803d', synNumber: '#b45309', synComment: '#8a968e',
      synFunction: '#1d4ed8', synType: '#c2410c', synVariable: '#1d2620', synProperty: '#0e7490',
      synOperator: '#4b5563', synTag: '#be123c', synAttr: '#b45309', synHeading: '#15803d', synMeta: '#66736b',
    },
    term: {
      black: '#1d2620', red: '#dc2626', green: '#15803d', yellow: '#a16207',
      blue: '#1d4ed8', magenta: '#9333ea', cyan: '#0e7490', white: '#d4dbd6',
      brightBlack: '#66736b', brightRed: '#ef4444', brightGreen: '#16a34a', brightYellow: '#ca8a04',
      brightBlue: '#2563eb', brightMagenta: '#a855f7', brightCyan: '#0891b2', brightWhite: '#f3f6f4',
    },
  },
};

Object.assign(THEMES, GHOSTTY_THEMES);

const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const mql = matchMedia('(prefers-color-scheme: light)');

// 'auto' follows the OS, using the last dark and last light theme you picked
// (Frog and Lily Pad until you've picked others).
export function themeChoice() { return localStorage.getItem('frog.theme') || 'frog'; }
export function autoPair() {
  const d = localStorage.getItem('frog.theme.dark'), l = localStorage.getItem('frog.theme.light');
  return { dark: THEMES[d] ? d : 'frog', light: THEMES[l] ? l : 'lilypad' };
}
export function resolveTheme(choice = themeChoice()) {
  if (choice === 'auto') { const p = autoPair(); return THEMES[mql.matches ? p.light : p.dark]; }
  return THEMES[choice] || THEMES.frog;
}

export function termTheme(t = resolveTheme()) {
  const u = t.ui;
  return {
    background: u.bg, foreground: u.fg, cursor: u.accent, cursorAccent: u.bg,
    selectionBackground: u.selection, ...t.term,
  };
}

export function applyTheme(choice = themeChoice()) {
  const t = resolveTheme(choice);
  const root = document.documentElement;
  for (const [k, v] of Object.entries({ ...t.ui, ...t.syn })) root.style.setProperty('--' + kebab(k), v);
  root.style.colorScheme = t.dark ? 'dark' : 'light';
  root.dataset.theme = t.dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.ui.bg2);
  return t;
}

export function setTheme(choice, views) {
  localStorage.setItem('frog.theme', choice);
  if (THEMES[choice]) localStorage.setItem(THEMES[choice].dark ? 'frog.theme.dark' : 'frog.theme.light', choice);
  const t = applyTheme(choice);
  for (const v of views) v.setTheme?.(t);
}

export function watchSystemTheme(getViews) {
  mql.addEventListener('change', () => { if (themeChoice() === 'auto') setTheme('auto', getViews()); });
}
