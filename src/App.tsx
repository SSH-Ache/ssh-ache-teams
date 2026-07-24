// @ts-nocheck
// SSH Ache — UI ported from the Claude Design handoff (`SSH Ache.dc.html`).
//
// The prototype's component logic is reused almost verbatim (state machine,
// renderVals, command/theme/pane/SFTP handlers); the design's templated markup
// is recreated here as JSX. Anything that needs the OS or a real socket is
// still demo-only — see docs/TASKS.md for the phase plan that wires it up.
//
// ponytail: @ts-nocheck — this is a faithful port of untyped prototype JS.
// It gets typed phase by phase as demo logic is replaced with real backend
// calls; typing it now would be churn against code that is about to change.
import * as React from "react";
import TeamsPanel from "./teams/TeamsPanel";
import * as teams from "./teams/client";
import { invoke, Channel } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { History, attachAutosuggest, parseShellHistory } from "./autosuggest";
import logoMark from "./assets/logo-mark.svg";

type S = React.CSSProperties;

// Parse a design-style inline CSS string ("a:b;c:d") into a React style object,
// so the prototype's literal style strings port across with no hand-conversion.
// ---- whole-app theming -------------------------------------------------
// The design hard-codes chrome colours as hex in every style string. We map
// those families to CSS variables here and set the variables per active theme,
// so changing the theme repaints the entire UI (not just the terminal). The
// THEMES palette data never passes through css(), so it is untouched.
const _hx = (h: string) => { h = h.replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; };
const _rx = (a: number[]) => "#" + a.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
const _mix = (a: string, b: string, t: number) => { const A = _hx(a), B = _hx(b); return _rx([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]); };
const lighten = (h: string, t: number) => _mix(h, "#ffffff", t);
const darken = (h: string, t: number) => _mix(h, "#000000", t);
const rgbStr = (h: string) => _hx(h).join(",");

const COLORMAP: Record<string, string> = {
  "#ededf0": "var(--text)", "#f2f2f5": "var(--text)",
  "#b9b9c2": "var(--text2)", "#cfcfd6": "var(--text2)", "#dcdce2": "var(--text2)", "#c7c7cf": "var(--text2)",
  "#9a9aa3": "var(--muted)", "#8b8b95": "var(--muted)", "#7e7e88": "var(--muted)",
  "#6a6a74": "var(--dim)", "#5c5c66": "var(--dim)",
  "#54545e": "var(--faint)", "#46464f": "var(--faint)",
  "#09090b": "var(--bg)", "#0a0a0b": "var(--bg)", "#0a0a0d": "var(--bg)", "#0b0b0e": "var(--bg)",
  "#0c0c10": "var(--surface)", "#0d0d11": "var(--surface)", "#0e0e12": "var(--surface)", "#0e0e13": "var(--surface)",
  "#101015": "var(--surface2)", "#15151b": "var(--surface2)",
  "#16161c": "var(--line)", "#18181f": "var(--line)",
  "#1a1a20": "var(--border)", "#1c1c24": "var(--border)", "#1f1f27": "var(--border)", "#20202a": "var(--border)", "#23232c": "var(--border)",
  "#26262e": "var(--border2)", "#2a2a33": "var(--border2)", "#2c2c36": "var(--border2)", "#3a3a44": "var(--border2)",
  "#ff7a59": "var(--accent)", "#ff8d70": "var(--accent-hi)", "#0c0b0a": "var(--accent-ink)",
};
const _COLOR_RE = new RegExp(Object.keys(COLORMAP).join("|"), "g");
const themeColors = (str: string) =>
  str.replace(/rgba\(255,\s*122,\s*89,/g, "rgba(var(--accent-rgb),").replace(_COLOR_RE, (m) => COLORMAP[m]);

const lum = (h: string) => { const [r, g, b] = _hx(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };

// Derive the CSS-variable set for a theme; applied to the app root in render().
// Light themes invert the shade direction (surfaces darker than the page,
// borders darker), and the accent's text colour is chosen by its luminance.
const themeVars = (t: any): any => {
  const base = t.bg, fg = t.fg, acc = t.accent;
  const light = lum(base) > 0.5;
  const ink = lum(acc) > 0.6 ? "#15110e" : "#ffffff";
  // Text tiers always derive from the readable fg toward the bg, so contrast
  // holds on both light and dark themes (no tier washes out).
  const text2 = _mix(fg, base, 0.18), muted = _mix(fg, base, 0.34), dim = _mix(fg, base, 0.48), faint = _mix(fg, base, 0.58);
  const shell = light
    ? { "--bg": lighten(base, 0.04), "--surface": darken(base, 0.02), "--surface2": darken(base, 0.05), "--line": darken(base, 0.09), "--border": darken(base, 0.13), "--border2": darken(base, 0.22) }
    : { "--bg": darken(base, 0.30), "--surface": base, "--surface2": lighten(base, 0.05), "--line": darken(base, 0.14), "--border": lighten(base, 0.10), "--border2": lighten(base, 0.17) };
  return {
    ...shell,
    "--text": fg, "--text2": text2, "--muted": muted, "--dim": dim, "--faint": faint,
    "--accent": acc, "--accent-hi": light ? darken(acc, 0.08) : lighten(acc, 0.12), "--accent-rgb": rgbStr(acc), "--accent-ink": ink,
  };
};

const css = (str: string): S => {
  str = themeColors(str);
  const o: any = {};
  for (const part of str.split(";")) {
    const seg = part.trim();
    if (!seg) continue;
    const i = seg.indexOf(":");
    if (i < 0) continue;
    const key = seg
      .slice(0, i)
      .trim()
      .replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    o[key] = seg.slice(i + 1).trim();
  }
  return o;
};
// Style objects (built in renderVals with hardcoded hex) bypass css(), so remap
// their string colour values too — keeps object-built styles themed.
const _mapStyleObj = (o: any): S => { const r: any = {}; for (const k in o) { const val = o[k]; r[k] = typeof val === "string" ? themeColors(val) : val; } return r; };
const norm = (x: string | S): S => (typeof x === "string" ? css(x) : _mapStyleObj(x));

// Splitting an overridden `border` shorthand into longhands avoids React's
// "mixing shorthand and non-shorthand" warning when a hover/focus overlay
// changes only border-color over a base style that used the `border` shorthand.
const dedupeBorder = (st: any): S => {
  if (st.border && (st.borderColor || st.borderWidth || st.borderStyle)) {
    const m = String(st.border).match(/^(\S+)\s+(\S+)\s+(.+)$/);
    if (m) {
      if (!st.borderWidth) st.borderWidth = m[1];
      if (!st.borderStyle) st.borderStyle = m[2];
      if (!st.borderColor) st.borderColor = m[3];
    }
    delete st.border;
  }
  return st;
};

// ---- persistence: file store in Tauri, localStorage in the browser ----
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
// On macOS the window uses native traffic lights (titleBarStyle: Overlay), so we
// hide our custom min/max/close glyphs and leave room for them on the left.
const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent || (navigator as any).platform || "");

const AUTHOR = {
  name: "Noor Ajmir Tanvir",
  github: "https://github.com/TanvirMahin24",
  email: "tanvirmahin24@gmail.com",
  site: "https://tanvirmahin.com",
  tip: "https://www.patreon.com/cw/tanvirmahin24",
  motto: "Don't be so busy making a living that you forget to actually make a life.",
};

// First-run guided tour (centered stepper, skippable). Persisted via `tourSeen`.
const TOUR_STEPS = [
  { icon: "❯_", title: "Welcome to SSH Ache", body: "A fast desktop SSH client — terminal, files, and tunnels in one place. Take the 30-second tour?" },
  { icon: "+", title: "Save your connections", body: "Add hosts with “New host” (⌘N). Passwords and keys live in your OS keychain, never in plaintext." },
  { icon: "›_", title: "Terminal & splits", body: "Open real SSH or local-shell tabs. Split a pane with ⌘D, and run anything from the ⌘K command palette." },
  { icon: "⇅", title: "Move files over SFTP", body: "Press ⌘J for the SFTP panel, then drag files or whole folders between local and remote." },
  { icon: "◐", title: "Theme everything", body: "Hit ⌘T to switch theme — it repaints the entire app and the terminal together, not just the colours." },
  { icon: "♥", title: "Built by Noor Ajmir Tanvir", body: "That’s it! Add your first connection to begin. You can support the project any time from the ♥ menu." },
];
// Open a link in the OS browser. Tauri webview won't honour target=_blank, so
// route through the open_url command there; plain window.open in the browser.
const openExt = (url: string) => {
  if (isTauri) invoke("open_url", { url }).catch(() => {});
  else window.open(url, "_blank", "noopener");
};

const loadCfg = async (name: string): Promise<string> => {
  if (isTauri) { try { return await invoke<string>("read_config", { name }); } catch (_) { return ""; } }
  try { return localStorage.getItem("sshache." + name) || ""; } catch (_) { return ""; }
};
const saveCfg = (name: string, data: string) => {
  try { localStorage.setItem("sshache." + name, data); } catch (_) {}
  if (isTauri) invoke("write_config", { name, data }).catch(() => {});
};

// Minimal ~/.ssh/config parser → [{ alias, addr, user, port, keyPath, jump }].
// Skips wildcard Host patterns (Host * / ?). Captures the first ProxyJump hop as
// a bare alias/host (user@ and :port stripped); chained jumps are ignored.
function parseSshConfig(text: string) {
  const out: any[] = [];
  let cur: any = null;
  for (const lineRaw of (text || "").split(/\r?\n/)) {
    const line = lineRaw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "host") {
      if (cur) out.push(cur);
      const alias = val.split(/\s+/)[0];
      cur = /[*?]/.test(alias) ? null : { alias, addr: alias, user: "", port: "", keyPath: "", jump: "" };
      continue;
    }
    if (!cur) continue;
    if (key === "hostname") cur.addr = val;
    else if (key === "user") cur.user = val;
    else if (key === "port") cur.port = val;
    else if (key === "identityfile") cur.keyPath = val.replace(/^["']|["']$/g, "");
    else if (key === "proxyjump") {
      const first = val.split(",")[0].trim();
      if (first.toLowerCase() !== "none") cur.jump = first.replace(/^[^@]*@/, "").replace(/:\d+$/, "");
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Secrets live in the OS keychain (Tauri) — never in the config file or
// localStorage. Each host id maps to a JSON blob { password?, passphrase?, keyText? }.
const secretGet = async (id: string): Promise<any> => {
  if (!isTauri) return null;
  try { const s = await invoke<string>("secret_get", { id }); return s ? JSON.parse(s) : null; } catch (_) { return null; }
};
const secretSet = (id: string, obj: any) => { if (isTauri) invoke("secret_set", { id, value: JSON.stringify(obj) }).catch(() => {}); };
const secretDelete = (id: string) => { if (isTauri) invoke("secret_delete", { id }).catch(() => {}); };

// ---- encrypted backup (Web Crypto: PBKDF2-SHA256 → AES-256-GCM) ----
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const ub64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const deriveKey = async (password: string, salt: Uint8Array) => {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
};
const encryptJson = async (obj: any, password: string) => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return JSON.stringify({ app: "ssh-ache", v: 1, kdf: "PBKDF2-SHA256", iter: 200000, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) });
};
const decryptJson = async (envelope: string, password: string) => {
  const e = JSON.parse(envelope);
  const key = await deriveKey(password, ub64(e.salt));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(e.iv) }, key, ub64(e.ct));
  return JSON.parse(new TextDecoder().decode(pt));
};

// MCP server (local agent access). Fixed loopback port + a random bearer token.
const MCP_PORT = 8765;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;

// "What's new" changelog. Newest first; add an entry at the top when cutting a release.
const CHANGELOG = [
  { version: '0.7.5', items: [
    'Command autosuggest: as you type in the terminal, the most recent matching command from your history appears as dim ghost text — press Tab, → or End to accept. Fish-shell style, and 100% local: your history never leaves your machine.',
  ] },
  { version: '0.7.4', items: [
    'The app now connects to the official SSH Ache backend automatically — the Server URL field is gone. Existing sign-ins keep working.',
  ] },
  { version: '0.7.3', items: [
    'Key Vault: save an SSH private key once under a name, then reuse it across connections. Open it from the command palette (Key Vault) to add, reveal, or delete saved keys.',
    'Creating or editing a connection, you can now pick a saved key or save a new one to the vault — no more re-pasting the same key.',
    'Fixed: a connection’s key wasn’t viewable after it was created; editing now loads the saved key from your OS keychain.',
  ] },
  { version: '0.7.2', items: [
    'Create a connection inside a team folder and it’s automatically shared with the team — no separate step.',
    'Shared team connections: only owners and admins can add, edit, or delete them; members use them.',
  ] },
  { version: '0.7.1', items: [
    'Teams: leave a team, or delete a team you own, right from the Teams tab.',
    'Team connection cards now show online teammates on their own row, and “view session” uses a cleaner marker.',
    'New teams you create come up on your current plan (Pro/Enterprise) instead of always Free.',
  ] },
  { version: '0.7.0', items: [
    'Live view mode: on a team connection you can see who’s online and watch a teammate’s session in real time — read-only, in its own tab. Your SSH stays on your machine; only the on-screen output is shared.',
    'Redesigned team presence: an “N online” pill on each shared connection opens a list of active teammates (name + email) with one-click “View session”, and an avatar bar inside an open connection lets you jump straight into anyone’s session.',
    'Team-connection tabs are tinted green and view-mode tabs purple, so it’s always clear what you’re looking at.',
  ] },
  { version: '0.6.0', items: [
    'Teams, in the app: create teams, invite members (with a shareable code), manage members and roles, share keys, and accept invitations — no need to go to the website.',
    'Team connections sync into your Connections list automatically (no manual import), and a green badge shows which teammates are on a connection right now.',
    'Personal cloud vault: click ☁ on any local connection to save it to your account — encrypted end-to-end and synced to every device you sign in on.',
    'Fixed the team connection card looking wrong on light themes.',
  ] },
  { version: '0.5.0', items: [
    'Teams: connect the app straight from your browser — log in on the web, type the code the app shows, and it links itself. No email or password typed in the app, and your keys never leave your device unencrypted.',
    'Teams: a dashboard nudge to share connections with a team, and a clearer sign-in that spells out what Teams adds.',
  ] },
  { version: '0.4.0', items: [
    'SFTP: the terminal↔SFTP split is now resizable, folders open on a single click, and ⌘/Shift multi-select works.',
    'SFTP: right-click a file to open it with a local app; expand SFTP to a full-screen file manager.',
    'AI agent (MCP): opt-in per-host Auto-allow to skip the approval prompt on a host you trust.',
    'Teams: connections imported from a team are highlighted, and admins see each shared connection\'s last activity.',
    'Added this What\'s-new panel.',
    'SSH Ache is now source-available under the PolyForm Noncommercial license.',
  ] },
  { version: '0.3.1', items: ['Teams: fixed the connection list going blank right after importing shared connections.'] },
  { version: '0.3.0', items: ['New Teams module — sign in and import SSH connections your team shares with you, decrypted locally (end-to-end encrypted).'] },
  { version: '0.2.2', items: ['SFTP now matches the terminal for pasted key text, jump hosts and host-key checks, with a real key-file picker.'] },
  { version: '0.2.1', items: ['Output triggers — watch terminal output with a regex and get a marker plus a desktop notification.'] },
  { version: '0.2.0', items: ['Jump hosts (ProxyJump), SOCKS and remote port forwards, SFTP file operations, scrollback search, snippets, and a native macOS title bar.'] },
];
const genToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");

// Vault-lock passphrase: store a PBKDF2 hash (salt + derived bits), verify on unlock.
const hashPass = async (password: string, saltB64?: string) => {
  const salt = saltB64 ? ub64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" }, base, 256);
  return { salt: b64(salt), hash: b64(new Uint8Array(bits)) };
};

// Reproduces the design framework's `style-hover` / `style-focus` pseudo-styles
// that plain React inline styles can't express.
function Hov(props: any) {
  const { s, h, f, as = "div", children, onFocus, onBlur, ...rest } = props;
  const [hov, setHov] = React.useState(false);
  const [foc, setFoc] = React.useState(false);
  const Tag: any = as;
  const style: S = dedupeBorder({
    ...norm(s),
    ...(hov && h ? norm(h) : {}),
    ...(foc && f ? norm(f) : {}),
  });
  const isVoid = as === "input";
  return (
    <Tag
      {...rest}
      style={style}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onFocus={(e: any) => {
        if (f) setFoc(true);
        if (onFocus) onFocus(e);
      }}
      onBlur={(e: any) => {
        if (f) setFoc(false);
        if (onBlur) onBlur(e);
      }}
    >
      {isVoid ? null : children}
    </Tag>
  );
}

// Sidebar folder row: hover reveals a favourite star (left) and an edit icon
// (right); a favourited folder shows the star permanently.
function FolderRow({ folder }: any) {
  const [h, setH] = React.useState(false);
  const showStar = folder.favorite || h;
  return (
    <div onClick={folder.onSelect} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} style={folder.style}>
      <span onClick={(e) => { e.stopPropagation(); folder.onToggleFav(); }} title="Favorite folder"
        style={{ width: "13px", flex: "none", textAlign: "center", fontSize: "11px", cursor: "pointer", color: folder.favorite ? "#ffcf5c" : "#6a6a74", opacity: showStar ? 1 : 0 }}>
        {folder.favorite ? "★" : "☆"}
      </span>
      <span style={{ fontSize: "11px", flex: "none", width: "14px", textAlign: "center", color: folder.color }}>▸</span>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{folder.name}</span>
      {h ? (
        <span onClick={(e) => { e.stopPropagation(); folder.onEdit(); }} title="Edit folder" style={{ flex: "none", fontSize: "11px", cursor: "pointer", color: "#9a9aa3" }}>✎</span>
      ) : (
        <span style={{ flex: "none", fontSize: "10px", color: folder.countColor }}>{folder.count}</span>
      )}
    </div>
  );
}

// Map a theme to an xterm 16-colour palette. bg/fg/cursor track the theme and
// `blue` is tinted with the accent. ponytail: the rest is a fixed dark ANSI set
// — per-theme ANSI palettes would need colour data the design themes don't carry.
const xtermTheme = (t: any) => {
  const a = t.ansi || [];
  return {
    background: t.bg,
    foreground: t.fg,
    cursor: t.accent,
    cursorAccent: t.bg,
    selectionBackground: "rgba(255,255,255,0.18)",
    black: a[0] || "#0e1116", red: a[1] || "#f4584e", green: a[2] || "#3fb950", yellow: a[3] || "#d29922",
    blue: a[4] || t.accent, magenta: a[5] || "#bc8cff", cyan: a[6] || "#39c5cf", white: a[7] || t.fg,
    brightBlack: a[8] || "#8b98a5", brightRed: a[9] || "#ff6b62", brightGreen: a[10] || "#56d364", brightYellow: a[11] || "#e3b341",
    brightBlue: a[12] || t.accent, brightMagenta: a[13] || "#d2a8ff", brightCyan: a[14] || "#56d4dd", brightWhite: a[15] || "#ffffff",
  };
};
const cursorStyleOf = (c: string) => (c === "bar" ? "bar" : c === "underline" ? "underline" : "block");

// Build the autosuggest hook object, tolerating missing props (older callers / read-only panes).
function mkSuggestHooks(send: (d: string) => void, p: any, sessionId: string) {
  return {
    send,
    suggest: p.suggest || (() => null),
    record: p.recordCmd ? (cmd: string) => p.recordCmd(cmd, sessionId) : (() => {}),
    cfg: p.suggestCfg ? () => p.suggestCfg(sessionId) : (() => ({ on: false, color: "#8b8b95" })),
  };
}

// A live SSH pane: a real xterm.js terminal wired to the russh backend over a
// per-pane sessionId. Created once on mount; disconnected + disposed on unmount.
// In a plain browser (no Tauri runtime) it shows a hint instead of connecting.
function TermPane({ session, theme, fontSize, cursor, scrollback, onConnected, onError, onClosed, onHostKey, register, isBroadcast, onBroadcast, onCwd, getTriggers, onTrigger, suggest, recordCmd, suggestCfg, seedHistory }: any) {
  const wrapRef = React.useRef<any>(null);
  const inst = React.useRef<any>(null);
  const searchRef = React.useRef<any>(null);
  const [find, setFind] = React.useState<any>(null); // null | { q: string }

  React.useEffect(() => {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize,
      cursorBlink: true,
      cursorStyle: cursorStyleOf(cursor),
      scrollback: scrollback || 1000,
      theme: xtermTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    term.open(wrapRef.current);
    try { fit.fit(); } catch (_) {}
    term.focus();
    inst.current = { term, fit };
    if (register) register(session.sessionId, { clear: () => term.clear() });
    // ⌘F / Ctrl+F opens the in-terminal find bar (swallow it so the shell
    // never sees the keystroke).
    term.attachCustomKeyEventHandler((e: any) => {
      if (e.type === "keydown" && (e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        setFind((f: any) => f || { q: "" });
        return false;
      }
      return true;
    });
    // OSC 7 (file://host/path) — shells that emit it drive the live cwd shown in
    // the pane header. ponytail: silently ignored by shells that don't.
    try {
      term.parser.registerOscHandler(7, (data: string) => {
        let p = data;
        const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
        if (m) p = m[1];
        try { p = decodeURIComponent(p); } catch (_) {}
        if (onCwd && p) onCwd(p);
        return true;
      });
    } catch (_) {}

    // ---- output triggers: test regexes against completed output lines, then
    // notify (App toast) and/or drop a coloured gutter marker on the line.
    const td = new TextDecoder();
    let lineBuf = "";
    const reCache = new Map<string, any>();
    const lastFire: any = {};
    const stripAnsi = (str: string) => str
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC ... BEL/ST
      .replace(/\x1b[@-Z\\-_]|\x1b\[[0-9;?]*[ -\/]*[@-~]/g, ""); // CSI / others
    const compile = (t: any) => {
      const key = t.pattern + " " + (t.flags || "i");
      if (!reCache.has(key)) { let re = null; try { re = new RegExp(t.pattern, t.flags || "i"); } catch (_) {} reCache.set(key, re); }
      return reCache.get(key);
    };
    const scan = (bytes: Uint8Array) => {
      const list = getTriggers ? getTriggers() : null;
      if (!list || !list.length) { lineBuf = ""; return; }
      lineBuf += stripAnsi(td.decode(bytes, { stream: true }));
      if (lineBuf.length > 8192) lineBuf = lineBuf.slice(-8192); // cap progress-bar spam (\r only)
      const parts = lineBuf.split(/\r?\n/);
      lineBuf = parts.pop() || "";
      for (const raw of parts) {
        const line = raw.replace(/\r/g, "");
        if (!line) continue;
        for (const t of list) {
          const re = compile(t);
          if (!re) continue;
          try { re.lastIndex = 0; if (!re.test(line)) continue; } catch (_) { continue; }
          if (t.highlight !== false) {
            // ponytail: marker sits at the cursor line, so on a multi-line chunk
            // it can land a row or two below the match — the toast has the exact line.
            try {
              const marker = term.registerMarker(0);
              if (marker) {
                const dec = term.registerDecoration({ marker, width: term.cols });
                dec && dec.onRender && dec.onRender((el: any) => {
                  el.style.width = "100%"; el.style.pointerEvents = "none"; el.style.boxSizing = "border-box";
                  el.style.background = "rgba(255,255,255,.05)";
                  el.style.borderLeft = "3px solid " + (t.color || "#ff7a59");
                });
              }
            } catch (_) {}
          }
          if (t.notify !== false && onTrigger) {
            const now = Date.now();
            if (!lastFire[t.id] || now - lastFire[t.id] > 4000) { lastFire[t.id] = now; onTrigger(t, line, session); }
          }
        }
      }
    };

    const h = session.host || {};
    const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!isTauri) {
      term.writeln("\x1b[33mTerminal backend only runs inside the desktop app — start it with `npm run tauri dev`.\x1b[0m");
      if (onConnected) onConnected();
      return () => { if (register) register(session.sessionId, null); term.dispose(); };
    }

    let disposed = false;

    if (session.kind === "local") {
      const onDataL = new Channel<number[]>();
      onDataL.onmessage = (m) => { const u = new Uint8Array(m); term.write(u); scan(u); };
      const onCloseL = new Channel<string>();
      onCloseL.onmessage = () => { term.writeln("\r\n\x1b[90m— shell exited —\x1b[0m"); if (onClosed) onClosed(); };
      invoke("pty_spawn", { id: session.sessionId, cols: term.cols, rows: term.rows, onData: onDataL, onClose: onCloseL })
        .then(() => { if (!disposed && onConnected) onConnected(); })
        .catch((e) => { term.writeln(`\r\n\x1b[31mlocal shell failed: ${String(e)}\x1b[0m`); if (onError) onError(String(e)); });
      const sendL = (d: string) => {
        if (isBroadcast && isBroadcast() && onBroadcast) { onBroadcast(d); return; }
        invoke("pty_write", { id: session.sessionId, data: d }).catch(() => {});
      };
      const sugL = attachAutosuggest(term, wrapRef.current, mkSuggestHooks(sendL, { suggest, recordCmd, suggestCfg }, session.sessionId));
      const roL = new ResizeObserver(() => { try { fit.fit(); invoke("pty_resize", { id: session.sessionId, cols: term.cols, rows: term.rows }).catch(() => {}); } catch (_) {} });
      roL.observe(wrapRef.current);
      return () => {
        disposed = true;
        if (register) register(session.sessionId, null);
        roL.disconnect();
        sugL.dispose();
        invoke("pty_close", { id: session.sessionId }).catch(() => {});
        term.dispose();
      };
    }

    // ── Spectate (read-only): watch a teammate's session streamed from the relay. No SSH, no
    // input — inbound frames write straight to xterm. ──
    if (session.kind === "spectate") {
      term.writeln(`\x1b[90m→ connecting to ${session.watchName || "session"}…\x1b[0m`);
      let sws: WebSocket | null = null;
      try {
        sws = new WebSocket(session.wsUrl);
        sws.onmessage = (ev: any) => {
          let msg: any; try { msg = JSON.parse(ev.data); } catch (_) { return; }
          if (msg.type === "ready") { term.clear(); term.writeln(`\x1b[92m● watching ${session.watchName || ""} — read-only\x1b[0m\r\n`); if (onConnected) onConnected(); }
          else if (msg.type === "data" && typeof msg.data === "string") term.write(msg.data);
          else if (msg.type === "error") term.writeln(`\r\n\x1b[31m${msg.message || "relay error"}\x1b[0m`);
        };
        sws.onclose = () => { term.writeln(`\r\n\x1b[90m— session ended —\x1b[0m`); if (onClosed) onClosed(); };
        sws.onerror = () => { if (onError) onError("relay connection failed"); };
      } catch (e) {
        term.writeln(`\r\n\x1b[31mcould not connect: ${String(e)}\x1b[0m`); if (onError) onError(String(e));
      }
      const spySub = term.onData(() => {}); // read-only spectator — keystrokes go nowhere
      return () => {
        disposed = true;
        if (register) register(session.sessionId, null);
        spySub.dispose();
        if (sws) { try { sws.close(); } catch (_) {} }
        term.dispose();
      };
    }

    // Team connection → mirror our terminal OUTPUT to the relay so teammates can spectate it.
    // SSH stays local; only output leaves (never the secret or keystrokes). Best-effort: a mirror
    // failure never affects the local session.
    const mirror: { ws: WebSocket | null; enc: TextDecoder; tee: (u: Uint8Array) => void } = {
      ws: null,
      enc: new TextDecoder(),
      tee(u) { const w = this.ws; if (w && w.readyState === 1) { try { w.send(JSON.stringify({ type: "data", data: this.enc.decode(u, { stream: true }) })); } catch (_) {} } },
    };
    const startMirror = async () => {
      if (!h.teamId || !h.connId || !teams.isSignedIn()) return;
      const t = await teams.requestMirror(h.teamId, h.connId);
      if (!t || disposed) return;
      try {
        const w = new WebSocket(teams.relayWsUrl(t.relayUrl, t.ticket));
        w.onopen = () => { try { w.send(JSON.stringify({ type: "init", cols: term.cols, rows: term.rows })); } catch (_) {} };
        w.onerror = () => {};
        mirror.ws = w;
      } catch (_) {}
    };

    term.writeln(`\x1b[90m→ connecting ${h.user || ""}@${h.addr}:${h.port || 22}…\x1b[0m`);
    const onData = new Channel<number[]>();
    onData.onmessage = (m) => { const u = new Uint8Array(m); term.write(u); scan(u); mirror.tee(u); };
    const onClose = new Channel<string>();
    onClose.onmessage = () => { term.writeln("\r\n\x1b[90m— disconnected —\x1b[0m"); if (onClosed) onClosed(); };

    invoke("ssh_connect", {
      sessionId: session.sessionId,
      host: h.addr,
      port: Number(h.port) || 22,
      user: h.user || "root",
      auth: h.auth || "password",
      secret: session.secret || "",
      keyPath: h.keyPath || "",
      keyText: session.keyText || "",
      jump: session.jump || null,
      cols: term.cols,
      rows: term.rows,
      onData,
      onClose,
    })
      .then(() => {
        if (disposed) return;
        // On-connect snippet: run the host's saved command once the shell is up.
        if (h.snippet && h.snippet.trim()) invoke("ssh_write", { sessionId: session.sessionId, data: h.snippet.trim() + "\n" }).catch(() => {});
        void startMirror(); // if this is a team connection, start mirroring output for spectators
        // Seed autosuggest from the remote shell history (best-effort; only when the feature is on).
        try {
          const scfg = suggestCfg ? suggestCfg(session.sessionId) : null;
          if (scfg && scfg.on && seedHistory) {
            invoke("ssh_history", {
              host: h.addr, port: Number(h.port) || 22, user: h.user || "root", auth: h.auth || "password",
              secret: session.secret || "", keyPath: h.keyPath || "", keyText: session.keyText || "", jump: session.jump || null,
            }).then((txt) => { if (!disposed) seedHistory(String(txt || "")); }).catch(() => {});
          }
        } catch (_) {}
        if (onConnected) onConnected();
      })
      .catch((e) => {
        if (disposed) return;
        const msg = String(e);
        if (msg.indexOf("UNKNOWN_HOST") === 0) {
          const parts = msg.split(""); // ["UNKNOWN_HOST", fingerprint, openssh-key]
          term.writeln("\r\n\x1b[33m→ first time connecting to this host — confirm the key fingerprint to continue.\x1b[0m");
          if (onHostKey) onHostKey(parts[1] || "", parts[2] || "");
          return;
        }
        if (msg === "KEY_CHANGED" || /key.?chang|chang.+key/i.test(msg)) {
          term.writeln(`\r\n\x1b[1;31m⚠ HOST KEY CHANGED for ${h.addr} — possible man-in-the-middle.\x1b[0m`);
          term.writeln(`\x1b[31mRemove the stale ~/.ssh/known_hosts line if you trust the change, then reconnect.\x1b[0m`);
          if (onError) onError("host key changed for " + h.addr);
          return;
        }
        term.writeln(`\r\n\x1b[31mconnection failed: ${msg}\x1b[0m`);
        if (onError) onError(msg);
      });

    const sendS = (d: string) => {
      if (isBroadcast && isBroadcast() && onBroadcast) { onBroadcast(d); return; }
      invoke("ssh_write", { sessionId: session.sessionId, data: d }).catch(() => {});
    };
    const sug = attachAutosuggest(term, wrapRef.current, mkSuggestHooks(sendS, { suggest, recordCmd, suggestCfg }, session.sessionId));
    const ro = new ResizeObserver(() => {
      try { fit.fit(); invoke("ssh_resize", { sessionId: session.sessionId, cols: term.cols, rows: term.rows }).catch(() => {}); } catch (_) {}
    });
    ro.observe(wrapRef.current);

    return () => {
      disposed = true;
      if (register) register(session.sessionId, null);
      ro.disconnect();
      sug.dispose();
      if (mirror.ws) { try { mirror.ws.close(); } catch (_) {} }
      invoke("ssh_disconnect", { sessionId: session.sessionId }).catch(() => {});
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-apply theme / font / cursor / scrollback changes without re-mounting.
  React.useEffect(() => {
    const i = inst.current;
    if (!i) return;
    i.term.options.theme = xtermTheme(theme);
    i.term.options.fontSize = fontSize;
    i.term.options.cursorStyle = cursorStyleOf(cursor);
    i.term.options.scrollback = scrollback || 1000;
    try { i.fit.fit(); } catch (_) {}
  }, [theme.bg, theme.fg, theme.accent, fontSize, cursor, scrollback]);

  const runFind = (q: string, prev: boolean) => {
    const s = searchRef.current; if (!s || !q) return;
    if (prev) s.findPrevious(q); else s.findNext(q);
  };
  const closeFind = () => { setFind(null); if (inst.current) inst.current.term.focus(); };

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div ref={wrapRef} style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "6px 8px", background: theme.bg }} />
      {find && (
        <div style={{ position: "absolute", top: 8, right: 12, display: "flex", alignItems: "center", gap: 6, background: "#15151b", border: "1px solid #2a2a33", borderRadius: 8, padding: "5px 6px 5px 10px", boxShadow: "0 8px 24px rgba(0,0,0,.45)", zIndex: 8 }}>
          <input autoFocus value={find.q} placeholder="Find in terminal…" spellCheck={false}
            onChange={(e) => { const q = e.target.value; setFind({ q }); runFind(q, false); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); runFind(find.q, e.shiftKey); } else if (e.key === "Escape") { e.preventDefault(); closeFind(); } }}
            style={{ width: 180, background: "#0e0e12", border: "1px solid #20202a", borderRadius: 6, padding: "6px 9px", color: "#ededf0", font: "inherit", fontSize: 12, outline: "none" }} />
          <button title="Previous (⇧⏎)" onClick={() => runFind(find.q, true)} style={{ background: "transparent", border: "none", color: "#9a9aa3", cursor: "pointer", fontSize: 13, padding: "2px 4px" }}>↑</button>
          <button title="Next (⏎)" onClick={() => runFind(find.q, false)} style={{ background: "transparent", border: "none", color: "#9a9aa3", cursor: "pointer", fontSize: 13, padding: "2px 4px" }}>↓</button>
          <button title="Close (Esc)" onClick={closeFind} style={{ background: "transparent", border: "none", color: "#9a9aa3", cursor: "pointer", fontSize: 14, padding: "2px 4px" }}>×</button>
        </div>
      )}
    </div>
  );
}

// Key Vault: manage named, reusable private keys. Key text is stored in the OS keychain (never
// in plaintext state, never uploaded); this modal only shows metadata + reveal-on-demand.
function KeyVaultModal({ keys, onAdd, onDelete, onReveal, onClose }: any) {
  const [name, setName] = React.useState("");
  const [keyText, setKeyText] = React.useState("");
  const [passphrase, setPassphrase] = React.useState("");
  const [revealed, setRevealed] = React.useState<any>({});
  const inp: any = { width: "100%", boxSizing: "border-box", background: "#0e0e12", border: "1px solid #20202a", borderRadius: 8, padding: "10px 12px", color: "#ededf0", font: "inherit", fontSize: 13, outline: "none" };
  const add = () => { const id = onAdd(name, keyText, passphrase); if (id) { setName(""); setKeyText(""); setPassphrase(""); } };
  const reveal = async (id: string) => { const s = await onReveal(id); setRevealed((r: any) => ({ ...r, [id]: s.keyText })); };
  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(5,5,7,.6)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 40, zIndex: 70 }}>
      <div onClick={(e: any) => e.stopPropagation()} style={{ width: 560, maxWidth: "96%", maxHeight: "88vh", display: "flex", flexDirection: "column", background: "#0c0c10", border: "1px solid #26262e", borderRadius: 14, boxShadow: "0 36px 90px rgba(0,0,0,.65)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "15px 19px", borderBottom: "1px solid #18181f" }}>
          <span style={{ color: "#46d9a0" }}>🔑</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#f2f2f5" }}>Key Vault</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", color: "#8b8b95", border: "1px solid #26262e", borderRadius: 6, cursor: "pointer", background: "transparent" }}>×</button>
        </div>
        <div style={{ padding: 16, overflow: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 11, color: "#6a6a74" }}>Reusable private keys — stored encrypted in your OS keychain, never uploaded. Pick one when adding a connection.</div>
          {keys.length === 0 ? (
            <div style={{ padding: 18, textAlign: "center", color: "#6a6a74", fontSize: 12.5, border: "1px dashed #26262e", borderRadius: 10 }}>No saved keys yet — add one below.</div>
          ) : keys.map((k: any) => (
            <div key={k.id} style={{ padding: "11px 13px", background: "#0e0e13", border: "1px solid #1c1c24", borderRadius: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#ededf0", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.name}</span>
                <span style={{ fontSize: 10, color: "#6a6a74", border: "1px solid #20202a", borderRadius: 5, padding: "2px 6px", flex: "none" }}>{k.label}</span>
                <button onClick={() => void reveal(k.id)} style={{ background: "#101015", border: "1px solid #20202a", borderRadius: 6, color: "#9a9aa3", font: "inherit", fontSize: 11, padding: "5px 9px", cursor: "pointer" }}>Reveal</button>
                <button onClick={() => onDelete(k.id)} style={{ background: "#101015", border: "1px solid #20202a", borderRadius: 6, color: "#ff6b78", font: "inherit", fontSize: 11, padding: "5px 9px", cursor: "pointer" }}>Delete</button>
              </div>
              {revealed[k.id] && <pre style={{ margin: "8px 0 0", padding: 10, background: "#08080b", border: "1px solid #1c1c24", borderRadius: 8, color: "#9a9aa3", fontSize: 10.5, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 140, overflow: "auto" }}>{revealed[k.id]}</pre>}
            </div>
          ))}
          <div style={{ borderTop: "1px solid #18181f", marginTop: 4, paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: "#6a6a74" }}>Add a key</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. work-laptop)" style={inp} />
            <textarea value={keyText} onChange={(e) => setKeyText(e.target.value)} placeholder="Paste private key (PEM / OpenSSH)…" rows={4} spellCheck={false} style={{ ...inp, minHeight: 90, resize: "vertical", fontSize: 11.5, lineHeight: 1.5 }} />
            <input value={passphrase} onChange={(e) => setPassphrase(e.target.value)} type="password" placeholder="Passphrase (optional)" style={inp} />
            <button onClick={add} disabled={!name.trim() || !keyText.trim()} style={{ alignSelf: "flex-start", background: "#ff7a59", border: "none", borderRadius: 8, color: "#0c0b0a", font: "inherit", fontSize: 12.5, fontWeight: 700, padding: "9px 18px", cursor: "pointer", opacity: (!name.trim() || !keyText.trim()) ? 0.5 : 1 }}>Save key</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default class App extends React.Component<any, any> {
  paneWrap = React.createRef();
  paletteRef = React.createRef();
  inputRefs = {};
  termApis = {};
  registerTerm = (id, api) => { if (api) this.termApis[id] = api; else delete this.termApis[id]; };

  // Broadcast input: when on, a keystroke in any pane of the active tab is sent
  // to every live pane in that tab (cluster-ssh). Read live via a stable getter
  // so TermPane's mount-time onData closure always sees the current flag.
  isBroadcast = () => !!this.state.broadcast;
  broadcastInput = (data) => {
    const t = this.state.tabs.find(x => x.id === this.state.activeTabId);
    if (!t) return;
    t.panes.forEach(p => {
      if (!p.live) return;
      if (p.kind === 'local') invoke('pty_write', { id: p.sessionId, data }).catch(() => {});
      else invoke('ssh_write', { sessionId: p.sessionId, data }).catch(() => {});
    });
  };
  toggleBroadcast = () => this.setState(s => ({ broadcast: !s.broadcast, paletteOpen: false }));

  // ---- output triggers ----
  getTriggers = () => (this.state.settings && this.state.settings.triggers) || [];
  handleTrigger = (t, line, session) => {
    const where = (session && (session.host?.name || session.hostName)) || 'terminal';
    this.pushToast({ type: 'info', title: 'Trigger · ' + (t.label || t.pattern), msg: where + ': ' + line.trim().slice(0, 80) });
  };
  addTrigger = (pattern, color) => {
    const p = (pattern || '').trim();
    if (!p) return;
    try { new RegExp(p); } catch (e) { this.pushToast({ type: 'err', title: 'Bad pattern', msg: String(e).replace(/^.*?:/, '').trim() }); return; }
    const t = { id: this.genId(), pattern: p, flags: 'i', color: color || '#ff7a59', notify: true, highlight: true };
    this.setState(s => ({ settings: { ...s.settings, triggers: [...(s.settings.triggers || []), t] } }));
  };
  removeTrigger = (id) => this.setState(s => ({ settings: { ...s.settings, triggers: (s.settings.triggers || []).filter(t => t.id !== id) } }));
  toggleTriggerField = (id, field) => this.setState(s => ({ settings: { ...s.settings, triggers: (s.settings.triggers || []).map(t => t.id === id ? { ...t, [field]: !t[field] } : t) } }));

  // ---- command autosuggest (fish-style ghost text from history) ----
  // Kept in its own localStorage key, not in the `settings`/backup bundle, so captured commands
  // never ride along in an export or reach the backend. Loaded once here; saved debounced on Enter.
  hist = new History(1000, (() => { try { const r = localStorage.getItem('sshache.cmdhistory'); const a = r ? JSON.parse(r) : []; return Array.isArray(a) ? a : []; } catch (e) { return []; } })());
  _histT = null;
  saveHist = () => { clearTimeout(this._histT); this._histT = setTimeout(() => { try { localStorage.setItem('sshache.cmdhistory', JSON.stringify(this.hist.toJSON())); } catch (e) {} }, 800); };
  // Per-tab enable state. A tab's `suggest` is undefined by default (inherit the global Settings
  // toggle, which acts as the default); the status-bar badge sets an explicit true/false to override
  // for that tab. LATER (paid-only): AND tabSuggestOn with `teams.hasCommandSuggest()` — the
  // entitlement plumbing (platform flag + /me + client.ts) is in place, so the paid flip is one line.
  tabOfSession = (sessionId) => (this.state.tabs || []).find(t => (t.panes || []).some(p => p.sessionId === sessionId));
  // A tab's stable key across reloads is its host id (tabs are restored by host id — see openHosts).
  // Local-shell tabs have none, so their toggle is session-only.
  tabHostId = (tab) => { const p = ((tab && tab.panes) || []).find(pp => pp && pp.host && pp.host.id); return p ? p.host.id : null; };
  // Resolve a per-tab flag: this-session override on the tab, else the persisted per-host pref, else
  // undefined (inherit the global Settings default).
  suggestPref = (tab, field) => {
    if (tab && tab[field] !== undefined) return tab[field];
    const hid = this.tabHostId(tab);
    const prefs = (this.state.settings && this.state.settings.suggestPrefs) || {};
    if (hid && prefs[hid] && prefs[hid][field] !== undefined) return prefs[hid][field];
    return undefined;
  };
  tabSuggestOn = (tab) => { const v = this.suggestPref(tab, 'suggest'); return v !== undefined ? !!v : !!(this.state.settings || {}).cmdSuggest; };
  // Set the flag on the tab (immediate) and persist it per-host in settings.suggestPrefs (survives
  // reload via the existing state persistence). Host-less local tabs stay session-only.
  withSuggestPref = (s, tab, field, val) => {
    const tabs = s.tabs.map(t => t.id === tab.id ? { ...t, [field]: val } : t);
    const hid = this.tabHostId(tab);
    if (!hid) return { tabs };
    const prefs = { ...(s.settings.suggestPrefs || {}) };
    prefs[hid] = { ...(prefs[hid] || {}), [field]: val };
    return { tabs, settings: { ...s.settings, suggestPrefs: prefs } };
  };
  toggleTabSuggest = () => this.setState(s => { const tab = s.tabs.find(t => t.id === s.activeTabId); return tab ? this.withSuggestPref(s, tab, 'suggest', !this.tabSuggestOn(tab)) : null; });

  suggestFor = (prefix) => this.hist.suggest(prefix);
  // Record only when the pane's tab has autocomplete on (respects a per-tab off toggle).
  recordCmd = (cmd, sessionId) => { if (!this.tabSuggestOn(this.tabOfSession(sessionId))) return; this.hist.add(cmd); this.saveHist(); };
  // Seed history from a remote host's shell-history file (read over SFTP on connect). Local-only.
  // The caller gates on suggestCfg().on, so this just parses + stores.
  seedHistory = (raw) => {
    if (!raw) return;
    const cmds = parseShellHistory(raw);
    for (const c of cmds) this.hist.add(c);
    if (cmds.length) this.saveHist();
  };
  suggestCfg = (sessionId) => {
    const th = this.THEMES[this.state.themeId] || {};
    const tab = sessionId ? this.tabOfSession(sessionId) : this.state.tabs.find(t => t.id === this.state.activeTabId);
    return { on: this.tabSuggestOn(tab), color: th.fgDim || th.fg || '#8b8b95' };
  };

  // Live cwd from OSC 7 → pane header.
  setPaneCwd = (sessionId, cwd) => {
    if (!cwd) return;
    this.setState(s => ({ tabs: s.tabs.map(t => ({ ...t, panes: t.panes.map(p => p.sessionId === sessionId ? (p.cwd === cwd ? p : { ...p, cwd }) : p) })) }));
  };

  // Resolve a saved host id into the jump (bastion) credentials ssh_connect
  // needs. Returns null for none / self-reference / missing host. One hop only:
  // the jump host's own jumpHost is intentionally ignored.
  async buildJump(jumpId, selfId) {
    if (!jumpId || jumpId === selfId) return null;
    const jh = this.state.hosts.find(h => h.id === jumpId);
    if (!jh) return null;
    const auth = jh.auth || 'password';
    let secret = '', keyText = '';
    if (auth !== 'agent') {
      const saved = await secretGet(jh.id);
      if (auth === 'key') { secret = (saved && saved.passphrase) || ''; keyText = (saved && saved.keyText) || ''; }
      else { secret = (saved && saved.password) || ''; }
    }
    return { host: jh.addr, port: Number(jh.port) || 22, user: jh.user || 'root', auth, secret, keyPath: jh.keyPath || '', keyText };
  }

  uid = 100;
  _drag = null;

  THEMES = {
    ember:     { name:'Ember',      author:'ssh-ache',  downloads:'48.2k', bg:'#0c0b0a', fg:'#efe7e1', fgDim:'#b9aaa0', accent:'#ff7a59', sw:['#ff7a59','#ffb38a','#e0d4cc','#8a7d75','#211a16'], ansi:['#211a16','#ff6b62','#8fbf6a','#ffb86c','#ff9d7a','#d9a07a','#c9b8a8','#efe7e1','#8a7d75','#ff8d70','#a6d189','#ffd0a0','#ffb38a','#e0b89a','#e0d4cc','#ffffff'] },
    tokyo:     { name:'Tokyo Storm', author:'enkia',    downloads:'212k',  bg:'#1a1b26', fg:'#c0caf5', fgDim:'#7a82a8', accent:'#7aa2f7', sw:['#7aa2f7','#bb9af7','#7dcfff','#9ece6a','#f7768e'], ansi:['#1d202f','#f7768e','#9ece6a','#e0af68','#7aa2f7','#bb9af7','#7dcfff','#a9b1d6','#414868','#f7768e','#9ece6a','#e0af68','#7aa2f7','#bb9af7','#7dcfff','#c0caf5'] },
    catppuccin:{ name:'Mocha',      author:'catppuccin',downloads:'301k',  bg:'#1e1e2e', fg:'#cdd6f4', fgDim:'#8a8fb3', accent:'#f5c2e7', sw:['#f5c2e7','#cba6f7','#89dceb','#a6e3a1','#f38ba8'], ansi:['#45475a','#f38ba8','#a6e3a1','#f9e2af','#89b4fa','#f5c2e7','#94e2d5','#bac2de','#585b70','#f38ba8','#a6e3a1','#f9e2af','#89b4fa','#f5c2e7','#94e2d5','#a6adc8'] },
    gruvbox:   { name:'Gruvbox',    author:'morhetz',   downloads:'176k',  bg:'#282828', fg:'#ebdbb2', fgDim:'#a89984', accent:'#fabd2f', sw:['#fabd2f','#fe8019','#b8bb26','#83a598','#fb4934'], ansi:['#282828','#cc241d','#98971a','#d79921','#458588','#b16286','#689d6a','#a89984','#928374','#fb4934','#b8bb26','#fabd2f','#83a598','#d3869b','#8ec07c','#ebdbb2'] },
    nord:      { name:'Nord',       author:'arctic',    downloads:'264k',  bg:'#2e3440', fg:'#e5e9f0', fgDim:'#9aa3b5', accent:'#88c0d0', sw:['#88c0d0','#81a1c1','#a3be8c','#b48ead','#bf616a'], ansi:['#3b4252','#bf616a','#a3be8c','#ebcb8b','#81a1c1','#b48ead','#88c0d0','#e5e9f0','#4c566a','#bf616a','#a3be8c','#ebcb8b','#81a1c1','#b48ead','#8fbcbb','#eceff4'] },
    dracula:   { name:'Dracula',    author:'zeno',      downloads:'289k',  bg:'#282a36', fg:'#f8f8f2', fgDim:'#9ea3c0', accent:'#bd93f9', sw:['#bd93f9','#ff79c6','#8be9fd','#50fa7b','#ff5555'], ansi:['#21222c','#ff5555','#50fa7b','#f1fa8c','#bd93f9','#ff79c6','#8be9fd','#f8f8f2','#6272a4','#ff6e6e','#69ff94','#ffffa5','#d6acff','#ff92df','#a4ffff','#ffffff'] },
    ayu:       { name:'Ayu Mirage', author:'dempfi',    downloads:'94.1k', bg:'#1f2430', fg:'#cbccc6', fgDim:'#8b8f9a', accent:'#ffcc66', sw:['#ffcc66','#ffd580','#bae67e','#5ccfe6','#f28779'], ansi:['#191e2a','#ed8274','#a6cc70','#fad07b','#6dcbfa','#cfbafa','#90e1c6','#c7c7c7','#686868','#f28779','#bae67e','#ffd580','#73d0ff','#d4bfff','#95e6cb','#ffffff'] },
    rosepine:  { name:'Rosé Pine',  author:'rose-pine', downloads:'118k',  bg:'#191724', fg:'#e0def4', fgDim:'#908caa', accent:'#ebbcba', sw:['#ebbcba','#c4a7e7','#9ccfd8','#31748f','#eb6f92'], ansi:['#26233a','#eb6f92','#31748f','#f6c177','#9ccfd8','#c4a7e7','#ebbcba','#e0def4','#6e6a86','#eb6f92','#31748f','#f6c177','#9ccfd8','#c4a7e7','#ebbcba','#e0def4'] },
    onedark:   { name:'One Dark',   author:'atom',      downloads:'156k',  bg:'#282c34', fg:'#abb2bf', fgDim:'#828997', accent:'#61afef', sw:['#61afef','#c678dd','#56b6c2','#98c379','#e06c75'], ansi:['#282c34','#e06c75','#98c379','#e5c07b','#61afef','#c678dd','#56b6c2','#abb2bf','#5c6370','#e06c75','#98c379','#e5c07b','#61afef','#c678dd','#56b6c2','#ffffff'] },
    monokai:   { name:'Monokai',    author:'wimer',     downloads:'203k',  bg:'#272822', fg:'#f8f8f2', fgDim:'#a59f85', accent:'#66d9ef', sw:['#66d9ef','#ae81ff','#a6e22e','#f4bf75','#f92672'], ansi:['#272822','#f92672','#a6e22e','#f4bf75','#66d9ef','#ae81ff','#a1efe4','#f8f8f2','#75715e','#f92672','#a6e22e','#f4bf75','#66d9ef','#ae81ff','#a1efe4','#f9f8f5'] },
    solardark: { name:'Solarized Dark', author:'altercation', downloads:'241k', bg:'#002b36', fg:'#93a1a1', fgDim:'#586e75', accent:'#268bd2', sw:['#268bd2','#d33682','#2aa198','#859900','#dc322f'], ansi:['#073642','#dc322f','#859900','#b58900','#268bd2','#d33682','#2aa198','#eee8d5','#002b36','#cb4b16','#586e75','#657b83','#839496','#6c71c4','#93a1a1','#fdf6e3'] },
    solarlight:{ name:'Solarized Light', author:'altercation', downloads:'198k', bg:'#fdf6e3', fg:'#586e75', fgDim:'#93a1a1', accent:'#268bd2', sw:['#268bd2','#d33682','#2aa198','#859900','#dc322f'], ansi:['#073642','#dc322f','#859900','#b58900','#268bd2','#d33682','#2aa198','#eee8d5','#002b36','#cb4b16','#586e75','#657b83','#839496','#6c71c4','#93a1a1','#fdf6e3'] },
    ghlight:   { name:'GitHub Light', author:'github',  downloads:'312k',  bg:'#ffffff', fg:'#24292f', fgDim:'#6e7781', accent:'#0969da', sw:['#0969da','#8250df','#1a7f37','#bf8700','#cf222e'], ansi:['#24292e','#d73a49','#28a745','#dbab09','#0366d6','#5a32a3','#0598bc','#6a737d','#959da5','#cb2431','#22863a','#b08800','#005cc5','#5a32a3','#3192aa','#d1d5da'] },
    latte:     { name:'Latte',      author:'catppuccin',downloads:'167k',  bg:'#eff1f5', fg:'#4c4f69', fgDim:'#6c6f85', accent:'#8839ef', sw:['#8839ef','#ea76cb','#179299','#40a02b','#d20f39'], ansi:['#5c5f77','#d20f39','#40a02b','#df8e1d','#1e66f5','#ea76cb','#179299','#acb0be','#6c6f85','#d20f39','#40a02b','#df8e1d','#1e66f5','#ea76cb','#179299','#bcc0cc'] },
    dawn:      { name:'Rosé Pine Dawn', author:'rose-pine', downloads:'88.5k', bg:'#faf4ed', fg:'#575279', fgDim:'#797593', accent:'#d7827e', sw:['#d7827e','#907aa9','#56949f','#286983','#b4637a'], ansi:['#f2e9e1','#b4637a','#286983','#ea9d34','#56949f','#907aa9','#d7827e','#575279','#9893a5','#b4637a','#286983','#ea9d34','#56949f','#907aa9','#d7827e','#575279'] }
  };

  state = {
    sidebarOpen: true,
    sftpOpen: false,
    paletteOpen: false,
    themesOpen: false,
    aboutOpen: false,
    whatsNewOpen: false,
    paletteQuery: '',
    themeId: 'ember',
    tourSeen: false,
    tourStep: 0,
    appVersion: '0.0.0',
    update: null,        // null | { version, url, asset }
    updateChecking: false,
    view: 'dashboard',
    teamPresence: {}, // connId -> [{ userId, displayName, email, kind, sessionId }] of teammates active on it (not you)
    presenceModal: null, // { host, presence } — the "who's online" modal for a team connection card
    broadcast: false,
    search: '',
    activeFolder: 'all',
    activeTags: [],
    addHostOpen: false,
    settingsOpen: false,
    editingId: null,
    newHostId: null,
    hosts: [],
    vaultKeys: [], // [{ id, name, label, createdAt }] — private key text lives in the keychain (key:<id>)
    keysOpen: false, // Key Vault modal
    form: { name:'', host:'', port:'22', user:'', auth:'password', password:'', keyMode:'file', keyPath:'', keyText:'', passphrase:'', vaultKeyId:'', saveKeyName:'', folder:'', jumpHost:'', snippet:'', tagInput:'', tags:[] },
    settings: { fontSize:13, cursor:'block', scrollback:'10000', confirmClose:true, restoreTabs:true, lockIdle:false, triggers:[], teamsEmail:'', cmdSuggest:true, suggestPrefs:{} },
    activeTabId: 't1',
    activePaneId: 'p1',
    connecting: null,
    secretPrompt: null,
    hostKeyPrompt: null,
    confirmClose: null,
    clearConfirm: false,
    ioPrompt: null,
    locked: false,
    lockPrompt: null,
    unlockValue: '',
    fwdPrompt: null,
    forwards: [],
    folderMeta: {},
    folderEdit: null,
    mcpRunning: false,
    mcpLog: [],
    mcpOpen: false,
    approvalReq: null,
    transfer: null,
    dragOver: null,
    toasts: [],
    localFiles: [],
    remoteFiles: [],
    localPath: '',
    remotePath: '',
    sftpId: null,
    sftpStatus: 'idle', // idle | connecting | ready | error
    sftpErr: '',
    sftpW: 392, // resizable terminal↔SFTP split width (px)
    sftpCtx: null, // right-click context menu: { x, y, side, name, isDir }
    sftpMax: false, // SFTP expanded to fill the workspace (full-screen file manager)
    sftpPrompt: null, // null | { mode:'mkdir'|'rename'|'delete', ... }
    triggerDraft: '', triggerColor: '#ff7a59', // output-trigger add form
    conflict: null,
    conflictAll: false,
    conflictPolicy: null, // null | 'replace' | 'skip' (set by "Apply to all")
    queue: [],
    selLocal: [],
    selRemote: [],
    selAnchorLocal: null, // last-clicked index for Shift-range select
    selAnchorRemote: null,
    tabs: [
      { id:'t1', title:'localhost', host:'localhost', user:'you', addr:'shell', layout:'row', sizes:[100], panes:[
        { id:'p1', live:true, kind:'local', sessionId:'p1', host:{ addr:'localhost', user:'you' }, user:'you', hostName:'localhost', cwd:'~', input:'', lines:[] }
      ] }
    ]
  };

  // On-device persistence. Synchronous localStorage hydrate on construct (works
  // in the browser preview and as a Tauri migration source); componentDidMount
  // then loads the authoritative on-disk file in the desktop app. Sessions
  // (tabs/panes) stay ephemeral. Secrets are never part of this blob.
  constructor(props) {
    super(props);
    const d = this._loadSync();
    if (d) this.state = { ...this.state, ...this._merge(this.state, d) };
    this._bumpUid(this.state.hosts);
  }
  _loadSync() {
    try {
      const raw = localStorage.getItem('sshache.state') || localStorage.getItem('sshache.v04');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  _merge(base, d) {
    return {
      hosts: Array.isArray(d.hosts) ? d.hosts : base.hosts,
      settings: { ...base.settings, ...(d.settings || {}) },
      themeId: this.THEMES[d.themeId] ? d.themeId : base.themeId,
      sidebarOpen: typeof d.sidebarOpen === 'boolean' ? d.sidebarOpen : base.sidebarOpen,
      folderMeta: (d.folderMeta && typeof d.folderMeta === 'object') ? d.folderMeta : base.folderMeta,
      tourSeen: typeof d.tourSeen === 'boolean' ? d.tourSeen : base.tourSeen,
    };
  }
  // uid resets to 100 on every launch, but host ids ('x'+uid) are persisted — advance past the
  // hydrated ids so genId() never reissues an existing id. Without this, a new/imported host
  // collides with a saved one and secretSet(id) overwrites the WRONG host's keychain slot.
  _bumpUid(hosts) {
    const nums = (hosts || []).map((h) => parseInt(String((h && h.id) || '').replace(/^x/, ''), 10)).filter((n) => Number.isFinite(n));
    if (nums.length) this.uid = Math.max(this.uid, ...nums);
  }

  componentDidMount() {
    this._key = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      const k = (e.key || '').toLowerCase();
      if (meta && k === 'k') { e.preventDefault(); this.setState(s => ({ paletteOpen: !s.paletteOpen, paletteQuery: '' })); }
      else if (meta && k === 't') { e.preventDefault(); this.setState(s => ({ themesOpen: !s.themesOpen })); }
      else if (meta && k === 'd') { e.preventDefault(); this.splitRight(); }
      else if (meta && k === 'b') { e.preventDefault(); this.setState(s => ({ sidebarOpen: !s.sidebarOpen })); }
      else if (meta && k === 'j') { e.preventDefault(); this.toggleSftp(); }
      else if (meta && k === 'n') { e.preventDefault(); this.openAddHost(); }
      else if (meta && k === '1') { e.preventDefault(); this.setState({ view: 'dashboard' }); }
      else if (meta && k === '2') { e.preventDefault(); this.setState({ view: 'workspace' }); }
      else if (k === 'escape') { this.setState({ paletteOpen: false, themesOpen: false, addHostOpen: false, settingsOpen: false, aboutOpen: false, whatsNewOpen: false, sftpCtx: null }); }
    };
    window.addEventListener('keydown', this._key);
    // Resolve the real app version, then auto-check for a newer release once.
    if (isTauri) {
      getVersion().then((vsn) => { this.setState({ appVersion: vsn }, () => this.checkUpdate(false)); }).catch(() => {});
    }
    // Authoritative load from the on-disk store (Tauri); redundant in browser.
    loadCfg('state').then(raw => {
      if (!raw) return;
      let d;
      try { d = JSON.parse(raw); } catch (e) { return; }
      this.setState(s => this._merge(s, d), () => { this._bumpUid(this.state.hosts); this.maybeRestore(d); });
    });
    // Idle vault-lock: lock after 15 min of no interaction when enabled + set.
    this._lastActivity = Date.now();
    this._activity = () => { this._lastActivity = Date.now(); };
    window.addEventListener('mousemove', this._activity);
    window.addEventListener('keydown', this._activity);
    window.addEventListener('mousedown', this._activity);
    this._idle = setInterval(() => {
      const st = this.state.settings;
      if (st.lockIdle && st.lockHash && !this.state.locked && (Date.now() - this._lastActivity) > 15 * 60 * 1000) {
        this.setState({ locked: true });
      }
    }, 20000);
    // MCP: poll status + listen for per-command approval requests from the server.
    if (isTauri) {
      this.refreshMcp();
      import('@tauri-apps/api/event').then(({ listen }) => { listen('mcp-approval', (e) => this.setState({ approvalReq: e.payload })); }).catch(() => {});
    }
    // Team presence: report which team connection each live SSH pane is on, and poll who's active.
    this._hbTimer = setInterval(() => this.presenceHeartbeatTick(), 20000);
    this._presTimer = setInterval(() => this.presencePollTick(), 12000);
  }
  componentWillUnmount() {
    window.removeEventListener('keydown', this._key);
    window.removeEventListener('mousemove', this._activity);
    window.removeEventListener('keydown', this._activity);
    window.removeEventListener('mousedown', this._activity);
    clearTimeout(this._ct); clearInterval(this._tr); clearInterval(this._idle);
    clearInterval(this._hbTimer); clearInterval(this._presTimer);
  }
  hashAndSetLock = async (pw) => {
    if (!pw) return;
    const { salt, hash } = await hashPass(pw);
    this.setState(s => ({ settings: { ...s.settings, lockIdle: true, lockSalt: salt, lockHash: hash }, lockPrompt: null }));
    this.pushToast({ type: 'ok', title: 'Vault lock enabled', msg: 'Locks after 15 min idle' });
  };
  tryUnlock = async (pw) => {
    const st = this.state.settings;
    const { hash } = await hashPass(pw || '', st.lockSalt);
    if (hash === st.lockHash) { this._lastActivity = Date.now(); this.setState({ locked: false, unlockValue: '' }); }
    else this.pushToast({ type: 'err', title: 'Wrong passphrase', msg: 'Try again' });
  };
  lockNow = () => {
    if (this.state.settings.lockHash) this.setState({ locked: true });
    else this.setState({ lockPrompt: { mode: 'set', value: '' } });
  };

  // ---- local port forwarding (-L) ----
  // mode: 'local' (-L) | 'socks' (-D) | 'remote' (-R)
  startForward(mode = 'local') {
    if (!isTauri) { this.pushToast({ type: 'info', title: 'Port forward', msg: 'Available in the desktop app.' }); return; }
    const tab = this.state.tabs.find(t => t.id === this.state.activeTabId);
    const pane = tab && tab.panes.find(p => p.live && (p.kind || 'ssh') === 'ssh');
    if (!pane) { this.pushToast({ type: 'info', title: 'Port forward', msg: 'Open an SSH connection first.' }); return; }
    this.setState({ fwdPrompt: { mode, localPort: '', remoteHost: '127.0.0.1', remotePort: '', sessionId: pane.sessionId, host: pane.host, secret: pane.secret, keyText: pane.keyText, jump: pane.jump || null }, paletteOpen: false });
  }
  setFwd = (k, val) => this.setState(s => ({ fwdPrompt: s.fwdPrompt ? { ...s.fwdPrompt, [k]: val } : null }));
  submitForward = () => {
    const f = this.state.fwdPrompt;
    if (!f) return;
    const h = f.host, mode = f.mode || 'local';
    const base = { host: h.addr, port: Number(h.port) || 22, user: h.user || 'root', auth: h.auth || 'password', secret: f.secret || '', keyPath: h.keyPath || '', keyText: f.keyText || '' };
    if (mode === 'socks') {
      const lp = parseInt(f.localPort, 10);
      if (!lp) { this.pushToast({ type: 'err', title: 'Invalid proxy', msg: 'Need a local port.' }); return; }
      const label = `SOCKS5 · localhost:${lp}`, id = f.sessionId + ':socks:' + lp;
      this.setState({ fwdPrompt: null });
      invoke('socks_start', { id, ...base, localPort: lp })
        .then(() => { this.setState(s => ({ forwards: [...s.forwards, { id, sessionId: f.sessionId, label }] })); this.pushToast({ type: 'ok', title: 'SOCKS proxy started', msg: label }); })
        .catch((e) => this.pushToast({ type: 'err', title: 'Proxy failed', msg: String(e) }));
      return;
    }
    if (mode === 'remote') {
      const rp = parseInt(f.remotePort, 10), lp = parseInt(f.localPort, 10);
      if (!rp || !lp || !f.remoteHost.trim()) { this.pushToast({ type: 'err', title: 'Invalid forward', msg: 'Need remote port, local host, and local port.' }); return; }
      const label = `remote :${rp} → ${f.remoteHost.trim()}:${lp}`, id = f.sessionId + ':rfwd:' + rp;
      this.setState({ fwdPrompt: null });
      invoke('remote_forward_start', { id, ...base, remotePort: rp, localHost: f.remoteHost.trim(), localPort: lp })
        .then(() => { this.setState(s => ({ forwards: [...s.forwards, { id, sessionId: f.sessionId, label }] })); this.pushToast({ type: 'ok', title: 'Remote forward started', msg: label }); })
        .catch((e) => this.pushToast({ type: 'err', title: 'Remote forward failed', msg: String(e) }));
      return;
    }
    const lp = parseInt(f.localPort, 10), rp = parseInt(f.remotePort, 10);
    if (!lp || !rp || !f.remoteHost.trim()) { this.pushToast({ type: 'err', title: 'Invalid forward', msg: 'Need local port, remote host, and remote port.' }); return; }
    const label = `localhost:${lp} → ${f.remoteHost.trim()}:${rp}`, id = f.sessionId + ':fwd:' + lp;
    this.setState({ fwdPrompt: null });
    invoke('forward_start', { id, ...base, localPort: lp, remoteHost: f.remoteHost.trim(), remotePort: rp })
      .then(() => { this.setState(s => ({ forwards: [...s.forwards, { id, sessionId: f.sessionId, label }] })); this.pushToast({ type: 'ok', title: 'Port forward started', msg: label }); })
      .catch((e) => this.pushToast({ type: 'err', title: 'Forward failed', msg: String(e) }));
  };
  stopForwardsFor = (sids) => {
    if (!sids || !sids.length) return;
    const keep = [], drop = [];
    this.state.forwards.forEach(fw => (sids.includes(fw.sessionId) ? drop : keep).push(fw));
    if (!drop.length) return;
    drop.forEach(fw => { if (isTauri) invoke('forward_stop', { id: fw.id }).catch(() => {}); });
    this.setState({ forwards: keep });
  };
  stopAllForwards = () => {
    const n = this.state.forwards.length;
    this.state.forwards.forEach(fw => { if (isTauri) invoke('forward_stop', { id: fw.id }).catch(() => {}); });
    this.setState({ forwards: [] });
    this.pushToast({ type: 'info', title: 'Port forwards stopped', msg: n ? `${n} closed` : 'none active' });
  };

  // Wipe every saved connection, setting, and keychain secret, then reload.
  clearAllData = async () => {
    this.setState({ clearConfirm: false });
    if (isTauri) { for (const h of this.state.hosts) { try { await invoke('secret_delete', { id: h.id }); } catch (_) {} } }
    try { await saveCfg('state', JSON.stringify({ tourSeen: true })); } catch (_) {}
    this.pushToast({ type: 'ok', title: 'All data cleared', msg: 'Reloading…' });
    setTimeout(() => { try { (window as any).location.reload(); } catch (_) {} }, 400);
  };

  // ---- updates: compare the running version to the latest GitHub release ----
  _semverGt(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
    return false;
  }
  _pickAsset(assets) {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    let ext = null;
    if (/Mac/i.test(ua)) ext = '.dmg';
    else if (/Win/i.test(ua)) ext = '.msi';
    else if (/Linux/i.test(ua)) ext = '.AppImage';
    const a = ext && (assets || []).find((x) => (x.name || '').endsWith(ext));
    return a ? a.browser_download_url : null;
  }
  checkUpdate = async (manual) => {
    if (this.state.updateChecking) return;
    this.setState({ updateChecking: true });
    try {
      const res = await fetch('https://api.github.com/repos/SSH-Ache/ssh-ache-teams/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const latest = String(j.tag_name || '').replace(/^v/, '');
      const cur = this.state.appVersion;
      if (latest && this._semverGt(latest, cur)) {
        this.setState({ update: { version: latest, url: j.html_url, asset: this._pickAsset(j.assets) } });
        this.pushToast({ type: 'ok', title: 'Update available', msg: 'v' + latest + ' — open Settings to download' });
      } else {
        this.setState({ update: null });
        if (manual) this.pushToast({ type: 'info', title: "You're up to date", msg: 'v' + cur });
      }
    } catch (e) {
      if (manual) this.pushToast({ type: 'err', title: 'Update check failed', msg: String(e) });
    }
    this.setState({ updateChecking: false });
  };
  downloadUpdate = () => { const u = this.state.update; if (u) openExt(u.asset || u.url); };

  // ---- MCP server (local agent access) ----
  ensureMcpToken() {
    let t = this.state.settings.mcpToken;
    if (!t) { t = genToken(); this.setSetting('mcpToken', t); }
    return t;
  }
  refreshMcp() {
    if (!isTauri) return;
    invoke('mcp_status').then((s) => this.setState({ mcpRunning: !!s.running, mcpLog: Array.isArray(s.log) ? s.log : [] })).catch(() => {});
  }
  openMcp() { this.setState({ mcpOpen: true, settingsOpen: false }); this.refreshMcp(); }
  toggleMcp = () => {
    if (!isTauri) { this.pushToast({ type: 'info', title: 'MCP', msg: 'Available in the desktop app.' }); return; }
    if (this.state.mcpRunning) { invoke('mcp_stop').then(() => this.setState({ mcpRunning: false })).catch(() => {}); return; }
    const token = this.ensureMcpToken();
    invoke('mcp_start', { token, port: MCP_PORT }).then(() => this.setState({ mcpRunning: true })).catch((e) => this.pushToast({ type: 'err', title: 'MCP failed to start', msg: String(e) }));
  };
  mcpRespond = (allow) => {
    const r = this.state.approvalReq;
    if (!r) return;
    if (isTauri) invoke('mcp_approval_respond', { id: r.id, allow }).catch(() => {});
    this.setState({ approvalReq: null });
    if (allow) setTimeout(() => this.refreshMcp(), 600);
  };
  toggleHostAgent(id) {
    // Disabling agent access also clears auto-allow (can't auto-run a host the agent can't see).
    this.setState(s => ({ hosts: s.hosts.map(h => h.id === id ? { ...h, agentAllowed: !h.agentAllowed, agentAutoAllow: h.agentAllowed ? false : h.agentAutoAllow } : h) }));
  }
  toggleHostAgentAuto(id) {
    this.setState(s => ({ hosts: s.hosts.map(h => h.id === id ? { ...h, agentAutoAllow: !h.agentAutoAllow } : h) }));
  }
  componentDidUpdate(prevProps, prevState) {
    if (this.state.paletteOpen && !prevState.paletteOpen && this.paletteRef.current) {
      this.paletteRef.current.focus();
    }
    const openHosts = (st) => Array.from(new Set(st.tabs.flatMap(t => t.panes.filter(p => p.live).map(p => p.host && p.host.id)).filter(Boolean)));
    const keys = ['hosts', 'vaultKeys', 'settings', 'themeId', 'sidebarOpen', 'folderMeta', 'tourSeen'];
    const cur = openHosts(this.state);
    if (keys.some(k => this.state[k] !== prevState[k]) || JSON.stringify(cur) !== JSON.stringify(openHosts(prevState))) {
      saveCfg('state', JSON.stringify({
        hosts: this.state.hosts, vaultKeys: this.state.vaultKeys, settings: this.state.settings,
        themeId: this.state.themeId, sidebarOpen: this.state.sidebarOpen,
        folderMeta: this.state.folderMeta, tourSeen: this.state.tourSeen, openHosts: cur,
      }));
    }
  }

  genId() { this.uid += 1; return 'x' + this.uid; }

  // Frameless-window controls (Tauri only; no-op in the browser preview).
  winAction(a) {
    if (!isTauri) return;
    const w = getCurrentWindow();
    if (a === 'min') w.minimize();
    else if (a === 'max') w.toggleMaximize();
    else w.close();
  }

  pushToast(t) {
    const id = this.genId();
    this.setState(s => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => this.setState(s => ({ toasts: s.toasts.filter(x => x.id !== id) })), 3600);
  }

  _localTab() {
    // A real local shell (PTY) tab.
    const id = this.genId(), pid = this.genId();
    return { id, title: 'localhost', host: 'localhost', user: 'you', addr: 'shell', layout: 'row', sizes: [100], panes: [
      { id: pid, live: true, kind: 'local', sessionId: pid, host: { addr: 'localhost', user: 'you' }, user: 'you', hostName: 'localhost', cwd: '~' }
    ] };
  }

  newTab() {
    const t = this._localTab();
    this.setState(s => ({ tabs:[...s.tabs, t], activeTabId:t.id, activePaneId:t.panes[0].id }));
  }
  closeTab(id, force) {
    const tab = this.state.tabs.find(t => t.id === id);
    const live = !!(tab && tab.panes.some(p => p.live));
    if (!force && live && this.state.settings.confirmClose) {
      this.setState({ confirmClose: { tabId: id, name: tab.title } });
      return;
    }
    if (tab) this.stopForwardsFor(tab.panes.filter(p => p.live).map(p => p.sessionId));
    this.setState(s => this._closeTabState(s, id));
  }
  confirmCloseTab = () => {
    const c = this.state.confirmClose;
    this.setState({ confirmClose: null });
    if (c) this.closeTab(c.tabId, true);
  };
  // On launch, silently reconnect previously-open hosts that have a remembered
  // secret (or use the agent); skip any that would need an interactive prompt.
  async maybeRestore(d) {
    if (!isTauri || !this.state.settings.restoreTabs || !Array.isArray(d.openHosts)) return;
    for (const hid of d.openHosts) {
      const host = this.state.hosts.find(h => h.id === hid);
      if (!host) continue;
      const auth = host.auth || 'password';
      let secret = '', keyText = '';
      if (auth !== 'agent') {
        const saved = await secretGet(host.id);
        keyText = saved && saved.keyText ? saved.keyText : '';
        const v = saved ? (auth === 'key' ? saved.passphrase : saved.password) : undefined;
        const has = (x) => x !== undefined && x !== null;
        if (auth === 'key') { if (!keyText && !has(v)) continue; secret = has(v) ? v : ''; }
        else { if (!has(v)) continue; secret = v; }
      }
      const jump = await this.buildJump(host.jumpHost, host.id);
      this.beginConnect(host, secret, true, keyText, jump);
    }
  }
  _closeTabState(s, tabId) {
    const tabs = s.tabs.filter(t => t.id !== tabId);
    if (tabs.length === 0) { const nt = this._localTab(); return { tabs:[nt], activeTabId:nt.id, activePaneId:nt.panes[0].id }; }
    let activeTabId = s.activeTabId, activePaneId = s.activePaneId;
    if (s.activeTabId === tabId) { const nt = tabs[tabs.length - 1]; activeTabId = nt.id; activePaneId = nt.panes[0].id; }
    return { tabs, activeTabId, activePaneId };
  }

  addPane(dir) {
    this.setState(s => {
      const tabs = s.tabs.map(t => {
        if (t.id !== s.activeTabId) return t;
        if (t.panes.length >= 4) return t;
        const src = t.panes.find(p => p.id === s.activePaneId) || t.panes[0];
        let np;
        if (src.live) {
          // Splitting a live session opens a second, independent shell to the
          // same host (its own sessionId → its own backend SSH session).
          const nid = this.genId();
          np = { id: nid, live: true, kind: src.kind || 'ssh', sessionId: nid, host: src.host, secret: src.secret, keyText: src.keyText, jump: src.jump || null, user: src.user, hostName: src.hostName, cwd: src.cwd };
        } else {
          np = { id: this.genId(), user: src.user, host: src.host, cwd: src.cwd, input: '', lines: [
            { t: 'sys', x: 'SSH Ache — new pane' },
            { t: 'ok', x: '● ' + src.user + '@' + src.host }
          ] };
        }
        const panes = [...t.panes, np];
        const sizes = panes.map(() => 100 / panes.length);
        return { ...t, layout:dir, panes, sizes };
      });
      return { tabs };
    });
  }
  splitRight = () => this.addPane('row');
  splitDown = () => this.addPane('col');

  closePaneById(id) {
    this.setState(s => {
      const t = s.tabs.find(x => x.id === s.activeTabId);
      if (!t) return {};
      if (t.panes.length > 1) {
        const panes = t.panes.filter(p => p.id !== id);
        const sizes = panes.map(() => 100 / panes.length);
        return { tabs: s.tabs.map(x => x.id === t.id ? { ...x, panes, sizes } : x), activePaneId: panes[0].id };
      }
      return this._closeTabState(s, t.id);
    });
  }

  clearActive() {
    const tab = this.state.tabs.find(t => t.id === this.state.activeTabId);
    const pane = tab && tab.panes.find(p => p.id === this.state.activePaneId);
    if (pane && pane.live) { const api = this.termApis[pane.sessionId]; if (api) api.clear(); return; }
    this.setState(s => ({ tabs: s.tabs.map(t => t.id === s.activeTabId ? { ...t, panes: t.panes.map(p => p.id === s.activePaneId ? { ...p, lines: [] } : p) } : t) }));
  }

  evalCmd(cmd) {
    const c = cmd.split(/\s+/)[0];
    if (c === '') return [];
    if (c === 'clear' || c === 'cls') return null;
    if (c === 'help') return [
      { t:'out', x:'commands:' },
      { t:'dim', x:'  help   ls    pwd    whoami   date   echo' },
      { t:'dim', x:'  neofetch   theme   sftp   split   clear   exit' }
    ];
    if (c === 'ls' || c === 'll' || c === 'dir') return [
      { t:'out', x:'drwxr-xr-x  deploy  4.0K  src/' },
      { t:'out', x:'drwxr-xr-x  deploy  4.0K  assets/' },
      { t:'out', x:'-rw-r--r--  deploy  1.2K  Cargo.toml' },
      { t:'out', x:'-rw-r--r--  deploy  4.8K  README.md' },
      { t:'out', x:'-rwxr-xr-x  deploy  0.6K  build.rs' }
    ];
    if (c === 'pwd') return [{ t:'out', x:'/home/root' }];
    if (c === 'whoami') return [{ t:'out', x:'root' }];
    if (c === 'date') return [{ t:'out', x:new Date().toString() }];
    if (c === 'echo') return [{ t:'out', x:cmd.slice(5) }];
    if (c === 'neofetch' || c === 'fetch') return [
      { t:'accent', x:'   ┌─┐┌─┐┬ ┬  ┌─┐┌─┐┬ ┬┌─┐' },
      { t:'accent', x:'   └─┐└─┐├─┤  ├─┤│  ├─┤├┤ ' },
      { t:'accent', x:'   └─┘└─┘┴ ┴  ┴ ┴└─┘┴ ┴└─┘' },
      { t:'dim', x:'' },
      { t:'out', x:'  os      SSH Ache 0.4.0' },
      { t:'out', x:'  shell   zsh 5.9' },
      { t:'out', x:'  term    truecolor · 256 themes' },
      { t:'out', x:'  cloud   none — fully offline' },
      { t:'out', x:'  uptime  37 days' }
    ];
    if (c === 'theme' || c === 'themes') return [{ t:'ok', x:'opening theme browser…' }];
    if (c === 'sftp') return [{ t:'ok', x:'opening SFTP panel…' }];
    if (c === 'split') return [{ t:'ok', x:'splitting pane → ⌘D' }];
    if (c === 'exit' || c === 'logout') return [{ t:'dim', x:'(session preserved locally)' }];
    if (c === 'sudo') return [{ t:'err', x:'sudo: a password is required' }];
    return [{ t:'err', x: c + ': command not found — try `help`' }];
  }

  runCommand(paneId, raw) {
    const cmd = (raw || '').trim();
    const out = this.evalCmd(cmd);
    this.setState(s => ({
      tabs: s.tabs.map(t => ({ ...t, panes: t.panes.map(p => {
        if (p.id !== paneId) return p;
        if (out === null) return { ...p, lines: [], input: '' };
        return { ...p, lines: [...p.lines, { t:'cmd', x:'❯ ' + cmd }, ...out], input: '' };
      }) }))
    }));
    const c = cmd.split(/\s+/)[0];
    if (c === 'theme' || c === 'themes') setTimeout(() => this.setState({ themesOpen: true }), 130);
    else if (c === 'sftp') setTimeout(() => this.setState({ sftpOpen: true }), 130);
    else if (c === 'split') setTimeout(() => this.splitRight(), 130);
  }

  startResize(idx, e) {
    e.preventDefault(); e.stopPropagation();
    const s = this.state;
    const tab = s.tabs.find(t => t.id === s.activeTabId);
    if (!tab) return;
    const layout = tab.layout;
    const wrap = this.paneWrap.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const total = layout === 'row' ? rect.width : rect.height;
    const startPos = layout === 'row' ? e.clientX : e.clientY;
    const sizes = [...tab.sizes];
    const min = 12;
    const move = (ev) => {
      const cur = layout === 'row' ? ev.clientX : ev.clientY;
      let d = (cur - startPos) / total * 100;
      let a = sizes[idx - 1] + d, b = sizes[idx] - d;
      if (a < min) { b -= (min - a); a = min; }
      if (b < min) { a -= (min - b); b = min; }
      const ns = [...sizes]; ns[idx - 1] = a; ns[idx] = b;
      this.setState(st => ({ tabs: st.tabs.map(t => t.id === tab.id ? { ...t, sizes: ns } : t) }));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.style.cursor = layout === 'row' ? 'col-resize' : 'row-resize';
  }

  // ---- connect flow (real SSH) ----
  // password / key auth need a secret → prompt first; agent connects directly.
  // The live tab's TermPane runs ssh_connect and reports back through the pane
  // callbacks (handlePaneConnected / handlePaneError).
  async connectHost(host) {
    if (this.state.connecting) return;
    const auth = host.auth || 'password';
    const jump = await this.buildJump(host.jumpHost, host.id);
    if (auth === 'agent') { this.beginConnect(host, '', false, '', jump); return; }
    // Use remembered secrets from the keychain if present; otherwise prompt.
    const saved = await secretGet(host.id);
    const keyText = saved && saved.keyText ? saved.keyText : '';
    const has = (x) => x !== undefined && x !== null;
    if (auth === 'key') {
      // A pasted key with no passphrase still connects; otherwise saved/prompt.
      if (keyText && !has(saved && saved.passphrase)) { this.beginConnect(host, '', false, keyText, jump); return; }
      if (saved && has(saved.passphrase)) { this.beginConnect(host, saved.passphrase, false, keyText, jump); return; }
      this.setState({ secretPrompt: { host, kind: auth, value: '', keyText, jump }, paletteOpen: false });
      return;
    }
    if (saved && has(saved.password)) { this.beginConnect(host, saved.password, false, '', jump); return; }
    this.setState({ secretPrompt: { host, kind: auth, value: '', jump }, paletteOpen: false });
  }
  submitSecret = () => {
    const sp = this.state.secretPrompt;
    if (!sp) return;
    this.setState({ secretPrompt: null });
    this.beginConnect(sp.host, sp.value, false, sp.keyText || '', sp.jump || null);
  };
  cancelSecret = () => this.setState({ secretPrompt: null });
  beginConnect(host, secret, silent, keyText, jump) {
    const id = this.genId(), pid = this.genId();
    const tab = { id, title: host.name, host: host.name, user: host.user, addr: host.addr, layout: 'row', sizes: [100], panes: [
      { id: pid, live: true, kind: 'ssh', sessionId: pid, host, secret, keyText: keyText || '', jump: jump || null, user: host.user, hostName: host.name, cwd: '~' }
    ] };
    this.setState(s => ({ tabs: [...s.tabs, tab], activeTabId: id, activePaneId: pid, view: 'workspace', paletteOpen: false, ...(silent ? {} : { connecting: { host, secret, keyText: keyText || '', jump: jump || null, tabId: id, failed: false, step: 0 } }) }));
  }
  // Open a read-only "view mode" tab that watches a teammate's live session through the relay.
  async openSpectate(teamId, sessionId, name) {
    if (!teamId || !sessionId) return;
    let t;
    try { t = await teams.requestShadow(teamId, sessionId); }
    catch (e) { this.pushToast({ type: 'err', title: 'Can’t view session', msg: (e && e.message) || 'Session unavailable' }); return; }
    const wsUrl = teams.relayWsUrl(t.relayUrl, t.ticket);
    const id = this.genId(), pid = this.genId();
    const tab = { id, title: '◉ ' + (name || 'session'), host: name || 'session', user: '', addr: '', layout: 'row', sizes: [100], spectate: true, panes: [
      { id: pid, live: true, kind: 'spectate', sessionId: pid, wsUrl, watchName: name || 'session', teamId, watchSessionId: sessionId }
    ] };
    this.setState(s => ({ tabs: [...s.tabs, tab], activeTabId: id, activePaneId: pid, view: 'workspace', presenceModal: null }));
  }
  // Flip a pane's live-connection flag (drives the orange dot on the tab).
  setPaneConnected(tabId, paneId, val) {
    this.setState(s => ({ tabs: s.tabs.map(t => t.id === tabId ? { ...t, panes: t.panes.map(p => p.id === paneId ? { ...p, connected: val } : p) } : t) }));
  }
  handlePaneConnected(tab, paneId) {
    this.setPaneConnected(tab.id, paneId, true);
    const c = this.state.connecting;
    if (c && c.tabId === tab.id) {
      this.setState({ connecting: null });
      this.pushToast({ type: 'ok', title: 'Connected', msg: c.host.user + '@' + c.host.addr });
    }
  }
  handlePaneClosed(tab, paneId) { this.setPaneConnected(tab.id, paneId, false); }

  // ---- Team presence: report which team connection each live SSH pane is on, poll who's active ----
  presenceHeartbeatTick() {
    if (!teams.isSignedIn()) return;
    const seen = new Set();
    for (const t of this.state.tabs) {
      for (const p of (t.panes || [])) {
        const h = p.live && p.host;
        if (h && h.teamId && h.connId && !seen.has(h.teamId + ':' + h.connId)) {
          seen.add(h.teamId + ':' + h.connId);
          void teams.heartbeat(h.teamId, h.connId);
        }
      }
    }
  }
  async presencePollTick() {
    if (!teams.isSignedIn()) {
      if (Object.keys(this.state.teamPresence || {}).length) this.setState({ teamPresence: {} });
      return;
    }
    const me = teams.currentUserId();
    const map = {};
    for (const m of teams.currentMemberships()) {
      const entries = await teams.getPresence(m.teamId);
      for (const e of entries) {
        if (e.userId === me) continue; // don't show yourself
        (map[e.connectionId] = map[e.connectionId] || []).push(e);
      }
    }
    this.setState({ teamPresence: map });
  }
  handlePaneError(tab, paneId, msg) {
    this.setPaneConnected(tab.id, paneId, false);
    const c = this.state.connecting;
    if (c && c.tabId === tab.id) {
      this.setState(s => ({ connecting: s.connecting ? { ...s.connecting, failed: true } : null }));
      clearTimeout(this._ct);
      this._ct = setTimeout(() => { this.setState({ connecting: null }); this.closeTab(tab.id, true); }, 1300);
    }
    this.pushToast({ type: 'err', title: 'Connection failed', msg: msg.length > 90 ? msg.slice(0, 90) + '…' : msg });
  }
  // First-seen host key: pause, show the fingerprint, let the user decide.
  handleHostKey(tab, fp, key) {
    const c = this.state.connecting;
    if (!c) return;
    this.setState({ connecting: null, hostKeyPrompt: { host: c.host, secret: c.secret, keyText: c.keyText || '', jump: c.jump || null, tabId: tab.id, fp, key } });
  }
  acceptHostKey = () => {
    const hk = this.state.hostKeyPrompt;
    if (!hk) return;
    this.setState({ hostKeyPrompt: null });
    this.closeTab(hk.tabId, true);
    const proceed = () => this.beginConnect(hk.host, hk.secret, false, hk.keyText || '', hk.jump || null);
    if (isTauri) {
      invoke('trust_host', { host: hk.host.addr, port: Number(hk.host.port) || 22, key: hk.key })
        .then(proceed)
        .catch((e) => this.pushToast({ type: 'err', title: 'Could not trust host', msg: String(e) }));
    } else { proceed(); }
  };
  rejectHostKey = () => {
    const hk = this.state.hostKeyPrompt;
    if (!hk) return;
    this.setState({ hostKeyPrompt: null });
    this.closeTab(hk.tabId, true);
    this.pushToast({ type: 'info', title: 'Connection cancelled', msg: hk.host.name });
  };
  cancelConnect = () => {
    const c = this.state.connecting;
    clearTimeout(this._ct);
    this.setState({ connecting: null });
    if (c && c.tabId) this.closeTab(c.tabId, true);
  };

  // ---- SFTP transfer queue (multi-file / folder drag-drop) ----
  // SFTP row click (Finder-style): plain click opens a folder / selects a single file;
  // ⌘/Ctrl-click toggles it in the selection; Shift-click range-selects from the anchor.
  onFileClick(side, f, e) {
    const listKey = side === 'local' ? 'localFiles' : 'remoteFiles';
    const selKey = side === 'local' ? 'selLocal' : 'selRemote';
    const anchorKey = side === 'local' ? 'selAnchorLocal' : 'selAnchorRemote';
    const s = this.state;
    const list = s[listKey];
    const idx = list.findIndex(x => x.name === f.name);
    if (e.shiftKey && s[anchorKey] != null) {
      const anchor = s[anchorKey];
      const [a, b] = anchor <= idx ? [anchor, idx] : [idx, anchor];
      this.setState({ [selKey]: list.slice(a, b + 1).map(x => x.name) });
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      const cur = s[selKey];
      const next = cur.includes(f.name) ? cur.filter(n => n !== f.name) : [...cur, f.name];
      this.setState({ [selKey]: next, [anchorKey]: idx });
      return;
    }
    if (f.kind === 'dir') {
      const base = side === 'local' ? s.localPath : s.remotePath;
      const path = this._sftpJoin(base, f.name);
      if (side === 'local') this.listLocal(path); else this.listRemote(path);
      return;
    }
    this.setState({ [selKey]: [f.name], [anchorKey]: idx });
  }
  // Drag a divider to resize the terminal↔SFTP split (SFTP panel is on the right).
  startSftpResize(e) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startW = this.state.sftpW;
    const maxW = Math.max(320, window.innerWidth - 360); // always leave room for the terminal
    const move = (ev) => {
      const w = Math.max(300, Math.min(maxW, startW + (startX - ev.clientX)));
      this.setState({ sftpW: w });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
  }
  // Drop onto the opposite pane: enqueue the dragged item(s) and start draining.
  sftpDrop(targetSide) {
    const d = this._drag;
    this._drag = null;
    this.setState({ dragOver: null });
    if (!d || d.side === targetSide) return;
    const dir = targetSide === 'remote' ? 'up' : 'down';
    const items = (d.items || []).filter(it => it && it.name && it.name !== '..');
    if (!items.length) return;
    this.setState(s => ({ queue: [...s.queue, ...items.map(file => ({ file, dir }))] }), () => this.processQueue());
  }
  processQueue() {
    if (this.state.transfer || this.state.conflict || !this.state.sftpId) return;
    const q = this.state.queue;
    // Batch drained: forget any "apply to all" choice so the next drop prompts again.
    if (!q.length) { if (this.state.conflictPolicy || this.state.conflictAll) this.setState({ conflictPolicy: null, conflictAll: false }); return; }
    const next = q[0];
    this.setState({ queue: q.slice(1) }, () => {
      const { file, dir } = next;
      const destList = dir === 'up' ? this.state.remoteFiles : this.state.localFiles;
      const exists = destList.some(e => e.name === file.name);
      if (exists) {
        const policy = this.state.conflictPolicy;
        if (policy === 'skip') { this.pushToast({ type: 'info', title: 'Skipped', msg: file.name }); this.processQueue(); return; }
        if (policy !== 'replace') { this.setState({ conflict: { file, dir }, conflictAll: false }); return; }
      }
      this.doTransfer(file, dir);
    });
  }
  resolveConflict = (action) => {
    const c = this.state.conflict;
    if (!c) return;
    const all = this.state.conflictAll;
    this.setState({ conflict: null, conflictAll: false, conflictPolicy: all ? action : this.state.conflictPolicy }, () => {
      if (action === 'replace') this.doTransfer(c.file, c.dir);
      else { this.pushToast({ type: 'info', title: 'Skipped', msg: c.file.name }); this.processQueue(); }
    });
  };
  // One transfer (file or recursive folder), progress streamed via a Channel.
  doTransfer(file, dir) {
    if (this.state.transfer || !this.state.sftpId) return;
    const id = this.state.sftpId;
    const join = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
    const localFull = join(this.state.localPath, file.name);
    const remoteFull = join(this.state.remotePath, file.name);
    const isDir = file.kind === 'dir';
    this.setState({ transfer: { name: file.name, pct: 0, dir } });
    const onProgress = new Channel();
    onProgress.onmessage = (p) => this.setState(s => (s.transfer ? { transfer: { ...s.transfer, pct: p } } : {}));
    const cmd = dir === 'up' ? (isDir ? 'sftp_put_dir' : 'sftp_put') : (isDir ? 'sftp_get_dir' : 'sftp_get');
    const args = dir === 'up'
      ? { id, localPath: localFull, remotePath: remoteFull, onProgress }
      : { id, remotePath: remoteFull, localPath: localFull, onProgress };
    invoke(cmd, args).then(() => {
      this.pushToast({ type: 'ok', title: dir === 'up' ? 'Uploaded' : 'Downloaded', msg: file.name });
      if (dir === 'up') this.listRemote(this.state.remotePath); else this.listLocal(this.state.localPath);
      this.setState({ transfer: null }, () => this.processQueue());
    }).catch((e) => {
      this.pushToast({ type: 'err', title: 'Transfer failed', msg: String(e) });
      this.setState({ transfer: null }, () => this.processQueue());
    });
  }

  // ---- SFTP right-click context menu ----
  openFileCtx(side, f, e) {
    e.preventDefault();
    e.stopPropagation();
    // Select the right-clicked file (unless already in a multi-selection) so rename/delete/open target it.
    const selKey = side === 'local' ? 'selLocal' : 'selRemote';
    const patch = { sftpCtx: { x: e.clientX, y: e.clientY, side, name: f.name, isDir: f.kind === 'dir' } };
    if (!this.state[selKey].includes(f.name)) patch[selKey] = [f.name];
    this.setState(patch);
  }
  closeFileCtx = () => { if (this.state.sftpCtx) this.setState({ sftpCtx: null }); };
  async openFileExternal(side, name, isDir) {
    this.closeFileCtx();
    if (isDir) { // "Open" a folder = navigate into it
      const base = side === 'local' ? this.state.localPath : this.state.remotePath;
      const p = this._sftpJoin(base, name);
      if (side === 'local') this.listLocal(p); else this.listRemote(p);
      return;
    }
    if (!isTauri) { this.pushToast({ type: 'info', title: 'Open', msg: 'Available in the desktop app.' }); return; }
    try {
      if (side === 'local') {
        await invoke('open_path', { path: this._sftpJoin(this.state.localPath, name) });
      } else {
        if (!this.state.sftpId) return;
        await invoke('sftp_open_external', { id: this.state.sftpId, remotePath: this._sftpJoin(this.state.remotePath, name), name });
        this.pushToast({ type: 'ok', title: 'Opening', msg: name });
      }
    } catch (err) { this.pushToast({ type: 'err', title: 'Open failed', msg: String(err) }); }
  }
  revealLocal = () => {
    this.closeFileCtx();
    if (isTauri) invoke('open_path', { path: this.state.localPath }).catch((err) => this.pushToast({ type: 'err', title: 'Reveal failed', msg: String(err) }));
  };

  // ---- SFTP panel ----
  toggleSftp() {
    if (this.state.sftpOpen) { this.closeSftp(); return; }
    this.setState({ sftpOpen: true }, () => this.openSftp());
  }
  closeSftp() {
    const id = this.state.sftpId;
    if (id && isTauri) invoke('sftp_disconnect', { id }).catch(() => {});
    this.setState({ sftpOpen: false, sftpMax: false, sftpId: null, sftpStatus: 'idle', transfer: null, conflict: null, conflictAll: false, conflictPolicy: null });
  }
  openSftp() {
    const tab = this.state.tabs.find(t => t.id === this.state.activeTabId);
    const pane = tab && tab.panes.find(p => p.live && (p.kind || 'ssh') === 'ssh');
    if (!isTauri) { this.setState({ sftpStatus: 'error', sftpErr: 'SFTP runs in the desktop app (npm run tauri dev).' }); return; }
    if (!pane) { this.setState({ sftpStatus: 'error', sftpErr: 'Open an SSH connection first, then reopen SFTP.' }); return; }
    const id = tab.id + ':sftp';
    const h = pane.host;
    this.setState({ sftpStatus: 'connecting', sftpErr: '', sftpId: id, localFiles: [], remoteFiles: [], conflict: null, conflictAll: false, conflictPolicy: null });
    invoke('sftp_connect', { id, host: h.addr, port: Number(h.port) || 22, user: h.user || 'root', auth: h.auth || 'password', secret: pane.secret || '', keyPath: h.keyPath || '', keyText: pane.keyText || '', jump: pane.jump || null })
      .then(async (home) => {
        const lhome = await invoke('local_home');
        this.setState({ sftpStatus: 'ready', remotePath: home, localPath: lhome });
        this.listLocal(lhome);
        this.listRemote(home);
      })
      .catch((e) => this.setState({ sftpStatus: 'error', sftpErr: String(e) }));
  }
  listLocal(path) {
    invoke('local_list', { path }).then((files) => this.setState({ localFiles: files, localPath: path, selLocal: [], selAnchorLocal: null })).catch((e) => this.setState({ sftpErr: String(e) }));
  }
  listRemote(path) {
    const id = this.state.sftpId;
    if (!id) return;
    invoke('sftp_list', { id, path }).then((files) => this.setState({ remoteFiles: files, remotePath: path, selRemote: [], selAnchorRemote: null })).catch((e) => this.setState({ sftpErr: String(e) }));
  }
  // ---- remote SFTP file ops (mkdir / rename / delete) ----
  _sftpJoin(a, b) { return (a === '/' ? '' : (a || '').replace(/\/+$/, '')) + '/' + b; }
  sftpMkdirStart = () => { if (this.state.sftpId) this.setState({ sftpPrompt: { mode: 'mkdir', value: '' } }); };
  sftpRenameStart = () => {
    const sel = this.state.selRemote;
    if (sel.length !== 1) { this.pushToast({ type: 'info', title: 'Rename', msg: 'Select exactly one remote item.' }); return; }
    this.setState({ sftpPrompt: { mode: 'rename', value: sel[0], orig: sel[0] } });
  };
  sftpDeleteStart = () => {
    const sel = this.state.selRemote;
    if (!sel.length) { this.pushToast({ type: 'info', title: 'Delete', msg: 'Select remote items first.' }); return; }
    this.setState({ sftpPrompt: { mode: 'delete', names: sel } });
  };
  sftpPromptCancel = () => this.setState({ sftpPrompt: null });
  sftpPromptSubmit = async () => {
    const p = this.state.sftpPrompt; if (!p) return;
    const id = this.state.sftpId, base = this.state.remotePath;
    this.setState({ sftpPrompt: null });
    try {
      if (p.mode === 'mkdir') { const name = (p.value || '').trim(); if (!name) return; await invoke('sftp_mkdir', { id, path: this._sftpJoin(base, name) }); }
      else if (p.mode === 'rename') { const name = (p.value || '').trim(); if (!name || name === p.orig) return; await invoke('sftp_rename', { id, from: this._sftpJoin(base, p.orig), to: this._sftpJoin(base, name) }); }
      else if (p.mode === 'delete') {
        const list = this.state.remoteFiles;
        for (const nm of p.names) { const f = list.find(x => x.name === nm); await invoke('sftp_remove', { id, path: this._sftpJoin(base, nm), isDir: !!(f && f.kind === 'dir') }); }
      }
      this.listRemote(this.state.remotePath);
      this.pushToast({ type: 'ok', title: 'SFTP', msg: p.mode === 'mkdir' ? 'Folder created' : p.mode === 'rename' ? 'Renamed' : 'Deleted' });
    } catch (e) { this.pushToast({ type: 'err', title: 'SFTP error', msg: String(e) }); }
  };

  // ---- encrypted import / export ----
  // Export bundles hosts + settings + keychain secrets, encrypts with the user's
  // password (AES-256-GCM), and writes to a chosen file. Import reverses it.
  async exportConfig() {
    if (!isTauri) { this.pushToast({ type: 'info', title: 'Export', msg: 'Available in the desktop app.' }); return; }
    this.setState({ ioPrompt: { mode: 'export', value: '' } });
  }
  async importConfig() {
    if (!isTauri) { this.pushToast({ type: 'info', title: 'Import', msg: 'Available in the desktop app.' }); return; }
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ multiple: false, filters: [{ name: 'SSH Ache backup', extensions: ['json'] }] });
    if (!path || typeof path !== 'string') return;
    this.setState({ ioPrompt: { mode: 'import', value: '', path } });
  }
  ioCancel = () => this.setState({ ioPrompt: null });
  // Export a single connection (host + its secret), with an OPTIONAL password.
  async exportHost(host) {
    if (!isTauri) { this.pushToast({ type: 'info', title: 'Export', msg: 'Available in the desktop app.' }); return; }
    this.setState({ ioPrompt: { mode: 'export1', value: '', hostId: host.id, hostName: host.name, optional: true } });
  }
  async importHostFile() {
    if (!isTauri) { this.pushToast({ type: 'info', title: 'Import', msg: 'Available in the desktop app.' }); return; }
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ multiple: false, filters: [{ name: 'SSH Ache connection', extensions: ['json'] }] });
    if (!path || typeof path !== 'string') return;
    this.setState({ ioPrompt: { mode: 'import1', value: '', path, optional: true } });
  }
  _importOneHost(host, secret) {
    if (!host) return;
    const id = this.genId();
    const h = { ...host, id, online: true, lastUsed: 'never' };
    this.setState((s) => ({ hosts: [...s.hosts, h], view: 'dashboard', activeFolder: 'all', search: '', activeTags: [], newHostId: id }));
    if (secret) secretSet(id, secret);
    setTimeout(() => this.setState((s) => (s.newHostId === id ? { newHostId: null } : {})), 2200);
  }
  // Persist the Teams sign-in convenience field (email). Never the password. The backend URL is fixed.
  rememberTeams(email) {
    this.setState((s) => ({ settings: { ...s.settings, teamsEmail: email } }));
  }
  // Import a decrypted team connection into the local host list. Stays on the Teams view so
  // several can be imported in a row; re-importing the same host (same folder/addr/user/port)
  // updates it in place. The credential goes to the OS keychain, keyed by the new host id.
  importTeamHost({ meta, secret, teamName }) {
    const folder = 'Team · ' + (teamName || 'Shared');
    const addr = meta.host, user = meta.user || 'root', port = String(meta.port || 22);
    const existing = this.state.hosts.find((h) => h.addr === addr && h.user === user && String(h.port) === port && h.folder === folder);
    const id = existing ? existing.id : this.genId();
    const auth = meta.auth === 'key' ? 'key' : meta.auth === 'agent' ? 'agent' : 'password';
    const host = { id, name: meta.name, addr, port, user, auth, keyMode: secret && secret.keyText ? 'text' : 'file', keyPath: '', folder, tags: ['team'], jumpHost: '', snippet: '', online: true, lastUsed: 'never' };
    this.setState((s) => ({ hosts: existing ? s.hosts.map((h) => (h.id === id ? host : h)) : [...s.hosts, host] }));
    const sec = {};
    if (secret) { if (secret.password) sec.password = secret.password; if (secret.passphrase) sec.passphrase = secret.passphrase; if (secret.keyText) sec.keyText = secret.keyText; }
    if (Object.keys(sec).length) secretSet(id, sec);
    this.pushToast({ type: 'ok', title: existing ? 'Updated from Teams' : 'Imported from Teams', msg: meta.name });
  }

  // Push a local connection up to the personal cloud vault (E2EE): seal + upload, then convert the
  // local host into a synced vault host in place (no duplicate). Needs a signed-in Teams session.
  async saveToVault(h) {
    if (!teams.isSignedIn()) {
      this.pushToast({ type: 'info', title: 'Teams', msg: 'Sign in to Teams first, then save to your vault.' });
      this.setView('teams');
      return;
    }
    const teamId = teams.personalTeamId();
    if (!teamId) { this.pushToast({ type: 'err', title: 'No vault', msg: 'Personal vault not found — sign in again.' }); return; }
    try {
      const secret = (await secretGet(h.id)) || {};
      const meta = { schema: 1, name: h.name, host: h.addr, port: Number(h.port) || 22, user: h.user || 'root', auth: h.auth === 'key' ? 'key' : 'password' };
      const sec = { schema: 1, password: secret.password ?? null, passphrase: secret.passphrase ?? null, keyText: secret.keyText ?? null };
      const connId = await teams.createConnection(teamId, meta, sec);
      this.setState((s) => ({ hosts: s.hosts.map((x) => (x.id === h.id ? { ...x, teamId, connId, connVersion: 1, folder: 'Team · Personal', tags: Array.from(new Set([...(x.tags || []), 'team'])) } : x)) }));
      this.pushToast({ type: 'ok', title: 'Saved to cloud vault', msg: h.name });
    } catch (e) {
      this.pushToast({ type: 'err', title: 'Save failed', msg: String(e) });
    }
  }

  // The teamId for a "Team · <name>" folder, if it maps to one of your teams; else null.
  _teamForFolder(folder) {
    if (!teams.isSignedIn() || !folder || !folder.startsWith('Team · ')) return null;
    return teams.currentMemberships().find((m) => ('Team · ' + (m.teamName || 'Shared')) === folder) || null;
  }
  // Share an existing local host to a team (E2EE upload), keeping its folder. Used when a host is
  // added directly in a team folder, so teammates get it automatically. Owner/Admin only.
  async shareHostToTeam(hostId, teamId, secretOverride) {
    const h = this.state.hosts.find((x) => x.id === hostId);
    if (!h) return;
    try {
      // Prefer the caller's secret (avoids racing a just-written keychain entry); else read it back.
      const secret = secretOverride || (await secretGet(hostId)) || {};
      const meta = { schema: 1, name: h.name, host: h.addr, port: Number(h.port) || 22, user: h.user || 'root', auth: h.auth === 'key' ? 'key' : h.auth === 'agent' ? 'agent' : 'password' };
      const sec = { schema: 1, password: secret.password ?? null, passphrase: secret.passphrase ?? null, keyText: secret.keyText ?? null };
      const connId = await teams.createConnection(teamId, meta, sec);
      this.setState((s) => ({ hosts: s.hosts.map((x) => (x.id === hostId ? { ...x, teamId, connId, connVersion: 1, tags: Array.from(new Set([...(x.tags || []), 'team'])) } : x)) }));
      this.pushToast({ type: 'ok', title: 'Shared with team', msg: h.name });
    } catch (e) {
      this.pushToast({ type: 'err', title: 'Share failed', msg: String(e) });
    }
  }

  // ---- Auto-sync team connections into the vault (no manual import) ----
  // Pull every shared connection for the signed-in teams, decrypt locally, and upsert into the
  // host list keyed by the cloud connection id. A secret is only re-revealed when the connection
  // changed (version bump), and connections removed from the team are pruned. Runs after Teams
  // sign-in / linking and on demand.
  async syncAllTeams(force) {
    if (!teams.isSignedIn()) return;
    // Prune hosts for teams you're no longer in (left / deleted / removed) — a fully-gone team
    // never hits syncTeam's per-team prune below. Local (no teamId) hosts are kept.
    const memberTeamIds = new Set(teams.currentMemberships().map((m) => m.teamId));
    this.setState((s) => ({ hosts: s.hosts.filter((h) => !h.teamId || memberTeamIds.has(h.teamId)) }));
    let n = 0;
    for (const m of teams.currentMemberships()) {
      n += await this.syncTeam(m.teamId, m.teamName, force).catch(() => 0);
    }
    return n;
  }
  async syncTeam(teamId, teamName, force) {
    let conns;
    try { conns = await teams.listConnections(teamId); } catch { return 0; }
    const folder = 'Team · ' + (teamName || 'Shared');
    const ids = new Set(conns.map((c) => c.id));
    let changed = 0;
    for (const c of conns) {
      const existing = this.state.hosts.find((h) => h.connId === c.id);
      if (!force && existing && existing.connVersion === c.version) continue; // already current
      let secret = null;
      try { secret = await teams.revealSecret(teamId, c.id); } catch { /* no access — keep metadata */ }
      this._upsertTeamHost(teamId, folder, c, secret);
      changed += 1;
    }
    // Prune connections that were removed from the team.
    this.setState((s) => ({ hosts: s.hosts.filter((h) => h.teamId !== teamId || ids.has(h.connId)) }));
    return changed;
  }
  _upsertTeamHost(teamId, folder, c, secret) {
    const meta = c.meta;
    const existing = this.state.hosts.find((h) => h.connId === c.id);
    const id = existing ? existing.id : this.genId();
    const auth = meta.auth === 'key' ? 'key' : meta.auth === 'agent' ? 'agent' : 'password';
    const host = {
      id, name: meta.name, addr: meta.host, port: String(meta.port || 22), user: meta.user || 'root',
      auth, keyMode: secret && secret.keyText ? 'text' : 'file', keyPath: '', folder, tags: ['team'],
      teamId, connId: c.id, connVersion: c.version, jumpHost: '', snippet: '', online: true,
      lastUsed: existing ? existing.lastUsed : 'never',
    };
    this.setState((s) => ({ hosts: existing ? s.hosts.map((h) => (h.id === id ? host : h)) : [...s.hosts, host] }));
    if (secret) {
      const sec = {};
      if (secret.password) sec.password = secret.password;
      if (secret.passphrase) sec.passphrase = secret.passphrase;
      if (secret.keyText) sec.keyText = secret.keyText;
      if (Object.keys(sec).length) secretSet(id, sec);
    }
  }
  // Import hosts from ~/.ssh/config. Dedups against the vault by user@addr:port;
  // links ProxyJump to a matching host by alias/name (added or pre-existing).
  async importSshConfig() {
    if (!isTauri) { this.pushToast({ type: 'info', title: 'Import', msg: 'Available in the desktop app.' }); return; }
    let raw = '';
    try { raw = await invoke('read_ssh_config'); } catch (e) { this.pushToast({ type: 'err', title: 'Import failed', msg: String(e) }); return; }
    const parsed = parseSshConfig(raw);
    if (!parsed.length) { this.pushToast({ type: 'info', title: 'Nothing to import', msg: 'No hosts found in ~/.ssh/config.' }); return; }
    const byName: any = {};
    this.state.hosts.forEach(h => { byName[h.name] = h.id; });
    const existing = new Set(this.state.hosts.map(h => (h.user || 'root') + '@' + h.addr + ':' + (h.port || '22')));
    const newHosts: any[] = [];
    for (const e of parsed) {
      const key = (e.user || 'root') + '@' + e.addr + ':' + (e.port || '22');
      if (existing.has(key)) continue;
      existing.add(key);
      const id = this.genId();
      byName[e.alias] = id;
      newHosts.push({ id, _jump: e.jump, name: e.alias, addr: e.addr, user: e.user || 'root', port: e.port || '22',
        auth: e.keyPath ? 'key' : 'agent', keyMode: 'file', keyPath: e.keyPath || '',
        folder: 'Imported', tags: ['ssh-config'], online: true, lastUsed: 'never' });
    }
    const skipped = parsed.length - newHosts.length;
    if (!newHosts.length) { this.pushToast({ type: 'info', title: 'Already imported', msg: `${skipped} host(s) already in your vault.` }); return; }
    newHosts.forEach(h => { h.jumpHost = h._jump && byName[h._jump] ? byName[h._jump] : ''; delete h._jump; });
    this.setState(s => ({ hosts: [...s.hosts, ...newHosts], view: 'dashboard', activeFolder: 'all', search: '', activeTags: [], paletteOpen: false }));
    this.pushToast({ type: 'ok', title: 'Imported from ~/.ssh/config', msg: `${newHosts.length} host(s)` + (skipped ? `, ${skipped} skipped` : '') });
  }
  async ioSubmit() {
    const io = this.state.ioPrompt;
    if (!io) return;
    if (!io.optional && !io.value) { this.pushToast({ type: 'err', title: 'Password required', msg: 'Enter a password.' }); return; }
    this.setState({ ioPrompt: null });
    if (io.mode === 'export1') {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const host = this.state.hosts.find((h) => h.id === io.hostId);
      if (!host) return;
      const path = await save({ defaultPath: (host.name || 'connection') + '.sshache.json', filters: [{ name: 'SSH Ache connection', extensions: ['json'] }] });
      if (!path) return;
      try {
        const secret = await secretGet(host.id);
        const inner = { kind: 'ssh-ache-connection', host, secret: secret || null };
        const data = io.value ? await encryptJson(inner, io.value) : JSON.stringify({ kind: 'ssh-ache-connection-plain', host, secret: secret || null });
        await invoke('write_file', { path, data });
        this.pushToast({ type: 'ok', title: io.value ? 'Connection exported (encrypted)' : 'Connection exported', msg: host.name });
      } catch (e) {
        this.pushToast({ type: 'err', title: 'Export failed', msg: String(e) });
      }
      return;
    }
    if (io.mode === 'import1') {
      try {
        const raw = await invoke('read_file', { path: io.path });
        let parsed = null; try { parsed = JSON.parse(raw); } catch (_) {}
        let bundle;
        if (parsed && parsed.kind === 'ssh-ache-connection-plain') bundle = parsed;
        else bundle = await decryptJson(raw, io.value);
        if (!bundle || !bundle.host) throw new Error('invalid');
        this._importOneHost(bundle.host, bundle.secret);
        this.pushToast({ type: 'ok', title: 'Connection imported', msg: (bundle.host.name || '') });
      } catch (e) {
        this.pushToast({ type: 'err', title: 'Import failed', msg: 'Wrong password or invalid file.' });
      }
      return;
    }
    if (io.mode === 'export') {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({ defaultPath: 'ssh-ache-backup.json', filters: [{ name: 'SSH Ache backup', extensions: ['json'] }] });
      if (!path) return;
      try {
        const secrets = {};
        for (const h of this.state.hosts) { const s = await secretGet(h.id); if (s) secrets[h.id] = s; }
        const bundle = { kind: 'ssh-ache-backup', state: { hosts: this.state.hosts, settings: this.state.settings, themeId: this.state.themeId }, secrets };
        const envelope = await encryptJson(bundle, io.value);
        await invoke('write_file', { path, data: envelope });
        this.pushToast({ type: 'ok', title: 'Exported (encrypted)', msg: String(path) });
      } catch (e) {
        this.pushToast({ type: 'err', title: 'Export failed', msg: String(e) });
      }
    } else {
      try {
        const envelope = await invoke('read_file', { path: io.path });
        const bundle = await decryptJson(envelope, io.value);
        if (!bundle || bundle.kind !== 'ssh-ache-backup') throw new Error('not a backup');
        const st = bundle.state || {};
        this.setState((s) => this._merge(s, st));
        if (bundle.secrets) for (const id of Object.keys(bundle.secrets)) secretSet(id, bundle.secrets[id]);
        const n = Array.isArray(st.hosts) ? st.hosts.length : 0;
        this.pushToast({ type: 'ok', title: 'Imported', msg: n + ' host' + (n === 1 ? '' : 's') + ' restored' });
      } catch (e) {
        this.pushToast({ type: 'err', title: 'Import failed', msg: 'Wrong password or invalid file.' });
      }
    }
  }

  setView(v) { this.setState({ view: v, paletteOpen: false }); }

  openAddHost() {
    // Prefill the folder when you're viewing a team folder, so a new host lands there and is
    // auto-shared with that team.
    const af = this.state.activeFolder;
    const folder = (typeof af === 'string' && af.startsWith('Team · ')) ? af : '';
    this.setState({ addHostOpen: true, settingsOpen: false, paletteOpen: false, editingId: null,
      form: { name:'', host:'', port:'22', user:'', auth:'password', password:'', keyMode:'file', keyPath:'', keyText:'', passphrase:'', folder, jumpHost:'', snippet:'', tagInput:'', tags:[] } });
  }
  async openEditHost(h) {
    // Load the secret back from the keychain so the key/password IS viewable & editable (they
    // aren't stored on the host object). vaultKeyId shows which saved key it uses, if any.
    const saved = (await secretGet(h.id)) || {};
    this.setState({ addHostOpen: true, settingsOpen: false, paletteOpen: false, editingId: h.id,
      form: { name:h.name, host:h.addr, port:h.port, user:h.user, auth:h.auth, password: saved.password || '',
        keyMode: h.keyMode || 'file', keyPath: h.keyPath || '', keyText: saved.keyText || '', passphrase: saved.passphrase || '',
        vaultKeyId: h.vaultKeyId || '',
        folder:h.folder, jumpHost: h.jumpHost || '', snippet: h.snippet || '', tagInput:'', tags:[...h.tags] } });
  }

  // ---- Key Vault: named private keys, reusable across connections. Metadata in state.vaultKeys;
  // the key text + passphrase live in the OS keychain under 'key:<id>' (never plaintext in state). ----
  _keyLabel(keyText) {
    const t = (keyText || '').slice(0, 90);
    if (/BEGIN OPENSSH/.test(t)) return 'OpenSSH';
    if (/BEGIN RSA/.test(t)) return 'RSA';
    if (/BEGIN EC/.test(t)) return 'ECDSA';
    if (/BEGIN DSA/.test(t)) return 'DSA';
    if (/PuTTY-User-Key/.test(t)) return 'PuTTY';
    if (/BEGIN[\s\S]*PRIVATE KEY/.test(t)) return 'PEM';
    return 'Key';
  }
  addVaultKey(name, keyText, passphrase) {
    const nm = (name || '').trim();
    const kt = (keyText || '').trim();
    if (!nm || !kt) { this.pushToast({ type:'err', title:'Missing fields', msg:'A name and a private key are required' }); return null; }
    const v = this.validateKey(kt);
    if (v.state === 'error') { this.pushToast({ type:'err', title:'Invalid key', msg: v.message }); return null; }
    const id = 'vk' + this.genId();
    secretSet('key:' + id, { keyText: kt, passphrase: passphrase || '' });
    this.setState((s) => ({ vaultKeys: [...s.vaultKeys, { id, name: nm, label: this._keyLabel(kt), createdAt: Date.now() }] }));
    this.pushToast({ type:'ok', title:'Key saved', msg: nm });
    return id;
  }
  deleteVaultKey(id) {
    const k = this.state.vaultKeys.find((x) => x.id === id);
    if (!window.confirm('Delete the saved key "' + (k ? k.name : '') + '"? Connections already using it keep their own copy.')) return;
    secretSet('key:' + id, {}); // clear the keychain slot
    this.setState((s) => ({ vaultKeys: s.vaultKeys.filter((x) => x.id !== id) }));
  }
  async revealVaultKey(id) {
    const s = (await secretGet('key:' + id)) || {};
    return { keyText: s.keyText || '', passphrase: s.passphrase || '' };
  }
  // Load a saved key's text into the add-host form (used by the "Saved key" picker).
  async pickVaultKey(id) {
    const s = await this.revealVaultKey(id);
    this.setState((st) => ({ form: { ...st.form, vaultKeyId: id, keyText: s.keyText, passphrase: s.passphrase } }));
  }
  // Build an `ssh` command line for use in another terminal / tool.
  sshCommand(h) {
    const parts = ['ssh'];
    if (h.port && String(h.port) !== '22') parts.push('-p', String(h.port));
    if ((h.auth || 'password') === 'key' && h.keyPath) parts.push('-i', h.keyPath);
    parts.push((h.user || 'root') + '@' + h.addr);
    return parts.join(' ');
  }
  copyCommand(h) {
    const cmd = this.sshCommand(h);
    const ok = () => this.pushToast({ type: 'ok', title: 'Command copied', msg: cmd });
    try {
      navigator.clipboard.writeText(cmd).then(ok).catch(() => this.pushToast({ type: 'info', title: 'Copy this command', msg: cmd }));
    } catch (e) {
      this.pushToast({ type: 'info', title: 'Copy this command', msg: cmd });
    }
  }
  closeAddHost() { this.setState({ addHostOpen: false, editingId: null }); }
  setField(key, val) { this.setState(s => ({ form: { ...s.form, [key]: val } })); }
  addTagFromInput() {
    this.setState(s => {
      const v = (s.form.tagInput || '').trim().toLowerCase().replace(/\s+/g, '-');
      if (!v || s.form.tags.includes(v)) return { form: { ...s.form, tagInput: '' } };
      return { form: { ...s.form, tags: [...s.form.tags, v], tagInput: '' } };
    });
  }
  removeTag(t) { this.setState(s => ({ form: { ...s.form, tags: s.form.tags.filter(x => x !== t) } })); }

  validateKey(raw) {
    const text = (raw || '').trim();
    if (!text) return { state:'empty', type:'', message:'Paste a private key or certificate' };
    const pub = /^(ssh-rsa|ssh-ed25519|ssh-dss|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/]+={0,3}(\s+\S+)?$/;
    if (pub.test(text)) return { state:'valid', type:'OpenSSH public key', message:'Valid OpenSSH public key' };
    const begin = text.match(/^-----BEGIN ([A-Z0-9 ]+)-----/);
    const end = text.match(/-----END ([A-Z0-9 ]+)-----\s*$/);
    if (!begin) return { state:'error', type:'', message:'Missing "-----BEGIN …-----" header line' };
    if (!end) return { state:'error', type:'', message:'Missing "-----END …-----" footer line' };
    if (begin[1] !== end[1]) return { state:'error', type:'', message:'BEGIN/END labels differ — ' + begin[1] + ' vs ' + end[1] };
    const label = begin[1];
    const inner = text.replace(/-----BEGIN [A-Z0-9 ]+-----/, '').replace(/-----END [A-Z0-9 ]+-----/, '');
    const lines = inner.split(/\r?\n/).map(l => l.trim()).filter(l => l.length && !/^[A-Za-z][A-Za-z0-9-]*:/.test(l));
    const b64 = lines.join('');
    if (b64.length < 32) return { state:'error', type:'', message:'Key body looks truncated (too short)' };
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { state:'error', type:'', message:'Key body has invalid base64 characters' };
    try { atob(b64); } catch (e) { return { state:'error', type:'', message:'Key body is not valid base64 (check for missing lines)' }; }
    const names = {
      'OPENSSH PRIVATE KEY':'OpenSSH private key', 'RSA PRIVATE KEY':'RSA private key',
      'EC PRIVATE KEY':'EC private key', 'DSA PRIVATE KEY':'DSA private key',
      'PRIVATE KEY':'PKCS#8 private key', 'ENCRYPTED PRIVATE KEY':'encrypted PKCS#8 key',
      'CERTIFICATE':'X.509 certificate', 'PUBLIC KEY':'public key'
    };
    const type = names[label] || ('PEM block (' + label + ')');
    return { state:'valid', type, message:'Valid ' + type };
  }

  // Pull the secret fields out of the form; null when nothing to store.
  _formSecrets(f) {
    const s: any = {};
    if (f.auth === 'password' && f.password) s.password = f.password;
    if (f.auth === 'key' && f.passphrase) s.passphrase = f.passphrase;
    if (f.auth === 'key' && (f.keyMode === 'text' || f.keyMode === 'vault') && f.keyText.trim()) s.keyText = f.keyText;
    return Object.keys(s).length ? s : null;
  }
  saveHost() {
    const f = this.state.form;
    if (!f.name.trim() || !f.host.trim()) {
      this.pushToast({ type:'err', title:'Missing fields', msg:'Name and host/IP are required' });
      return;
    }
    if (f.auth === 'key' && f.keyMode === 'text' && f.keyText.trim() && this.validateKey(f.keyText).state === 'error') {
      this.pushToast({ type:'err', title:'Invalid key', msg: this.validateKey(f.keyText).message });
      return;
    }
    // Non-secret fields only — keyText / password / passphrase go to the keychain.
    const base = {
      name: f.name.trim(), user: (f.user.trim() || 'root'), addr: f.host.trim(),
      port: (f.port.trim() || '22'), folder: (f.folder.trim() || 'Uncategorized'),
      tags: f.tags, auth: f.auth, keyMode: f.keyMode, keyPath: f.keyPath, vaultKeyId: f.vaultKeyId || '', jumpHost: f.jumpHost || '', snippet: f.snippet || ''
    };
    const secrets = this._formSecrets(f);
    // "Save this key to the Key Vault" (paste mode) → create a named key + link the connection to it.
    if (f.auth === 'key' && f.keyMode === 'text' && (f.saveKeyName || '').trim() && f.keyText.trim()) {
      const vkId = this.addVaultKey(f.saveKeyName, f.keyText, f.passphrase);
      if (vkId) base.vaultKeyId = vkId;
    }
    if (this.state.editingId) {
      const id = this.state.editingId;
      this.setState(s => ({ hosts: s.hosts.map(h => h.id === id ? { ...h, ...base } : h), addHostOpen: false, editingId: null, newHostId: id }));
      if (secrets) secretSet(id, secrets);
      this.pushToast({ type:'ok', title:'Host updated', msg: base.name + ' · ' + base.user + '@' + base.addr });
      setTimeout(() => this.setState(s => (s.newHostId === id ? { newHostId: null } : {})), 2200);
      return;
    }
    const id = this.genId();
    const host = { id, ...base, online: true, lastUsed: 'never' };
    this.setState(s => ({ hosts: [...s.hosts, host], addHostOpen: false, editingId: null, view: 'dashboard', activeFolder: 'all', search: '', activeTags: [], newHostId: id }));
    if (secrets) secretSet(id, secrets);
    this.pushToast({ type:'ok', title:'Host added', msg: host.name + ' · ' + host.user + '@' + host.addr });
    // Added directly into a team folder → auto-share it with that team (Owner/Admin only).
    const mem = this._teamForFolder(base.folder);
    if (mem && (mem.role === 'OWNER' || mem.role === 'ADMIN')) {
      void this.shareHostToTeam(id, mem.teamId, secrets || {});
    } else if (mem) {
      this.pushToast({ type: 'info', title: 'Saved locally', msg: 'Only team admins can add shared connections to ' + (mem.teamName || 'this team') + '.' });
    }
    setTimeout(() => this.setState(s => (s.newHostId === id ? { newHostId: null } : {})), 2200);
  }
  deleteHost(id) {
    const h = this.state.hosts.find(x => x.id === id);
    this.setState(s => ({ hosts: s.hosts.filter(x => x.id !== id), addHostOpen: false, editingId: null }));
    secretDelete(id);
    this.pushToast({ type:'err', title:'Host removed', msg: h ? h.name : '' });
  }

  openSettings() { this.setState({ settingsOpen: true, addHostOpen: false, paletteOpen: false }); }
  closeSettings() { this.setState({ settingsOpen: false }); }
  setSetting(key, val) { this.setState(s => ({ settings: { ...s.settings, [key]: val } })); }

  setSearch(v) { this.setState({ search: v }); }
  setFolder(f) { this.setState({ activeFolder: f, view: 'dashboard' }); }
  toggleTag(t) {
    this.setState(s => ({ activeTags: s.activeTags.includes(t) ? s.activeTags.filter(x => x !== t) : [...s.activeTags, t] }));
  }

  // ---- folder colour / favourites ----
  toggleFolderFav(name) {
    this.setState(s => { const m = { ...(s.folderMeta[name] || {}) }; m.favorite = !m.favorite; return { folderMeta: { ...s.folderMeta, [name]: m } }; });
  }
  toggleHostFav(id) {
    this.setState(s => ({ hosts: s.hosts.map(h => h.id === id ? { ...h, favorite: !h.favorite } : h) }));
  }
  openFolderEdit(name) {
    const m = this.state.folderMeta[name] || {};
    this.setState({ folderEdit: { name, newName: name, color: m.color || '', favorite: !!m.favorite } });
  }
  setFolderEdit(k, v) { this.setState(s => ({ folderEdit: s.folderEdit ? { ...s.folderEdit, [k]: v } : null })); }
  saveFolderEdit() {
    const fe = this.state.folderEdit;
    if (!fe) return;
    const oldName = fe.name, newName = (fe.newName || '').trim() || oldName;
    this.setState(s => {
      let hosts = s.hosts, folderMeta = { ...s.folderMeta }, activeFolder = s.activeFolder;
      if (newName !== oldName) {
        hosts = s.hosts.map(h => h.folder === oldName ? { ...h, folder: newName } : h);
        delete folderMeta[oldName];
        if (activeFolder === oldName) activeFolder = newName;
      }
      folderMeta[newName] = { color: fe.color || '', favorite: !!fe.favorite };
      return { hosts, folderMeta, folderEdit: null, activeFolder };
    });
    this.pushToast({ type: 'ok', title: 'Folder updated', msg: newName });
  }

  renderVals() {
    const s = this.state;
    const theme = this.THEMES[s.themeId];
    const activeTab = s.tabs.find(t => t.id === s.activeTabId) || s.tabs[0];
    const layout = activeTab ? activeTab.layout : 'row';

    const lineColor = (t) => ({ cmd: theme.accent, out: theme.fg, dim: '#5c5c66', sys: '#7e7e88', ok: '#46d9a0', err: '#ff6b78', accent: theme.accent }[t] || theme.fg);

    const mkPanes = (tab) => tab.panes.map((p, i) => {
      const sizes = tab.sizes || [];
      const flex = sizes[i] || (100 / tab.panes.length);
      const active = p.id === s.activePaneId && tab.id === s.activeTabId;
      const tlayout = tab.layout;
      return {
        id: p.id, idx: i, notFirst: i > 0, active,
        cwd: p.cwd, input: p.input,
        hostLabel: p.live ? (p.user + '@' + (p.host && p.host.addr ? p.host.addr : (p.hostName || ''))) : (p.user + '@' + p.host),
        promptUser: p.user + '@' + p.host,
        promptColor: theme.accent,
        live: !!p.live, kind: p.kind || 'ssh', sessionId: p.sessionId, hostObj: p.live ? p.host : null, secret: p.secret, keyText: p.keyText, jump: p.jump || null,
        wsUrl: p.wsUrl, watchName: p.watchName,
        // Team-connection markers + who else is live on it right now (for the in-pane members bar).
        teamConn: !!(p.host && p.host.teamId && p.host.connId), spectate: p.kind === 'spectate',
        teamMembers: (p.host && p.host.teamId && p.host.connId) ? ((s.teamPresence || {})[p.host.connId] || []) : [],
        onWatch: (entry) => { if (p.host && entry.sessionId) this.openSpectate(p.host.teamId, entry.sessionId, entry.displayName); },
        termTheme: { bg: theme.bg, fg: theme.fg, accent: theme.accent, ansi: theme.ansi }, fontSize: s.settings.fontSize,
        cursor: s.settings.cursor, scrollback: parseInt(s.settings.scrollback, 10) || 1000,
        onConnected: () => this.handlePaneConnected(tab, p.id), onError: (msg) => this.handlePaneError(tab, p.id, msg),
        onClosed: () => this.handlePaneClosed(tab, p.id),
        onHostKey: (fp, key) => this.handleHostKey(tab, fp, key),
        onCwd: (path) => this.setPaneCwd(p.sessionId, path),
        onTrigger: this.handleTrigger,
        boxStyle: { position:'relative', flexGrow:flex, flexShrink:1, flexBasis:0, minWidth:0, minHeight:0, display:'flex', flexDirection:'column', background:theme.bg, border:'1px solid ' + (active ? 'rgba(255,122,89,.4)' : '#1a1a20'), borderRadius:'7px', overflow:'hidden', boxShadow: active ? '0 0 0 1px rgba(255,122,89,.12)' : 'none', transition:'border-color .15s ease' },
        resizerStyle: tlayout === 'row'
          ? { flex:'none', alignSelf:'stretch', width:'10px', cursor:'col-resize', display:'flex', alignItems:'center', justifyContent:'center', zIndex:6 }
          : { flex:'none', alignSelf:'stretch', height:'10px', cursor:'row-resize', display:'flex', alignItems:'center', justifyContent:'center', zIndex:6 },
        resizerBar: tlayout === 'row' ? { width:'2px', height:'34px' } : { height:'2px', width:'34px' },
        headStyle: { display:'flex', alignItems:'center', gap:'8px', padding:'7px 10px', borderBottom:'1px solid ' + (active ? 'rgba(255,122,89,.16)' : '#16161c'), background:'rgba(0,0,0,.2)', flex:'none' },
        termStyle: { flex:1, overflow:'auto', padding:'10px 13px 13px', color:theme.fg, caretColor:theme.accent, fontSize:s.settings.fontSize + 'px', lineHeight:'1.55', background:theme.bg },
        lines: (p.lines || []).map(l => ({ display: (l.x === '' ? ' ' : l.x), color: lineColor(l.t) })),
        onActivate: () => { this.setState({ activePaneId: p.id }); const el = this.inputRefs[p.id]; if (el) setTimeout(() => el.focus(), 0); },
        onInput: (e) => { const v = e.target.value; this.setState(st => ({ tabs: st.tabs.map(t => t.id === tab.id ? { ...t, panes: t.panes.map(pp => pp.id === p.id ? { ...pp, input: v } : pp) } : t) })); },
        onKey: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.runCommand(p.id, e.target.value); } },
        onClose: (e) => { e.stopPropagation(); this.closePaneById(p.id); },
        onGutterDown: (e) => this.startResize(i, e),
        setRef: (el) => { this.inputRefs[p.id] = el; }
      };
    });
    const panes = activeTab ? mkPanes(activeTab) : [];
    // Every tab's panes stay mounted; inactive tabs are hidden so their SSH/PTY
    // sessions (and xterm scrollback) survive a tab switch — only closeTab kills them.
    const tabPanes = s.tabs.map(t => ({
      id: t.id, active: t.id === s.activeTabId,
      wrapStyle: t.id === s.activeTabId
        ? { flex:1, minWidth:0, minHeight:0, display:'flex', flexDirection: t.layout === 'row' ? 'row' : 'column', gap:'2px' }
        : { display:'none' },
      panes: mkPanes(t),
    }));

    const tabs = s.tabs.map(t => {
      const sel = t.id === s.activeTabId;                                 // selected tab → outline + shadow
      const conn = t.panes.some(p => p.live && p.connected);             // any live pane connected → dot lit
      const isSpectate = !!t.spectate;                                    // view-mode tab (watching a teammate)
      const isTeam = !isSpectate && t.panes.some(p => p.host && p.host.teamId); // team connection tab
      const ac = isSpectate ? '168,112,255' : isTeam ? '70,217,160' : '255,122,89'; // purple / green / orange
      const acHex = isSpectate ? '#a970ff' : isTeam ? '#46d9a0' : '#ff7a59';
      const themed = isTeam || isSpectate;
      return {
      id: t.id, title: t.title, active: sel,
      style: { display:'flex', alignItems:'center', gap:'8px', padding:'0 8px 0 11px', height:'30px', borderRadius:'6px', cursor:'pointer', fontSize:'12px', color: sel ? '#ededf0' : '#8b8b95', background: sel ? '#15151b' : (themed ? 'rgba(' + ac + ',.06)' : 'transparent'), border:'1px solid ' + (sel ? 'rgba(' + ac + ',.5)' : (themed ? 'rgba(' + ac + ',.28)' : 'transparent')), boxShadow: sel ? '0 0 0 1px rgba(' + ac + ',.14), 0 2px 9px rgba(0,0,0,.4)' : 'none', maxWidth:'175px', flex:'none' },
      dotStyle: { width:'7px', height:'7px', borderRadius:'50%', background: isSpectate ? acHex : (conn ? (isTeam ? acHex : '#ff7a59') : '#3a3a44'), flex:'none', boxShadow: (isSpectate || (conn && isTeam)) ? '0 0 6px rgba(' + ac + ',.6)' : 'none' },
      onSelect: () => this.setState({ activeTabId: t.id, activePaneId: t.panes[0].id }),
      onClose: (e) => { e.stopPropagation(); this.closeTab(t.id); }
    };});

    const themesList = Object.keys(this.THEMES).map(id => {
      const th = this.THEMES[id];
      const active = id === s.themeId;
      return {
        id, name: th.name, author: th.author, downloads: th.downloads, bg: th.bg, fg: th.fg, accent: th.accent, sw: th.sw, active,
        cardStyle: { padding:'12px', background:'#101015', border:'1px solid ' + (active ? 'rgba(255,122,89,.45)' : '#1e1e26'), borderRadius:'10px', cursor:'pointer', transition:'border-color .15s ease', boxShadow: active ? '0 0 0 1px rgba(255,122,89,.1)' : 'none' },
        onApply: () => { this.setState({ themeId: id }); this.pushToast({ type:'ok', title:'Theme applied', msg: th.name + ' · by ' + th.author }); }
      };
    });

    // command palette
    const baseItems = [
      { name:'Add host', hint:'⌘N', icon:'+', color:'#ff7a59', run: () => this.openAddHost() },
      { name:'Key Vault', hint:'', icon:'🔑', color:'#46d9a0', run: () => this.setState({ keysOpen: true }) },
      { name:'Import from ~/.ssh/config', hint:'hosts', icon:'⤓', color:'#6ea8ff', run: () => this.importSshConfig() },
      { name: (s.broadcast ? 'Broadcast input: ON — turn off' : 'Broadcast input to all panes'), hint:'cluster', icon:'⇉', color:'#ff7a59', run: () => this.toggleBroadcast() },
      { name:'Open dashboard', hint:'⌘1', icon:'⊞', color:'#6ea8ff', run: () => this.setState({ view:'dashboard' }) },
      { name:'Open terminal', hint:'⌘2', icon:'›_', color:'#46d9a0', run: () => this.setState({ view:'workspace' }) },
      { name:'Settings', hint:'', icon:'⚙', color:'#9a9aa3', run: () => this.openSettings() },
      { name:'New tab', hint:'shell', icon:'+', color:'#6ea8ff', run: () => this.newTab() },
      { name:'Split right', hint:'⌘D', icon:'▢', color:'#ff7a59', run: () => this.splitRight() },
      { name:'Split down', hint:'', icon:'▢', color:'#ff7a59', run: () => this.splitDown() },
      { name:'Close pane', hint:'', icon:'×', color:'#ff6b78', run: () => this.closePaneById(this.state.activePaneId) },
      { name:'Browse themes', hint:'⌘T', icon:'◐', color:'#bd93f9', run: () => this.setState({ themesOpen: true }) },
      { name:"What's new", hint:'', icon:'✦', color:'#46d9a0', run: () => this.setState({ whatsNewOpen: true }) },
      { name:'Open SFTP panel', hint:'⌘J', icon:'⇅', color:'#46d9a0', run: () => this.setState({ sftpOpen: true }, () => this.openSftp()) },
      { name:'Toggle sidebar', hint:'⌘B', icon:'▤', color:'#9a9aa3', run: () => this.setState(st => ({ sidebarOpen: !st.sidebarOpen })) },
      { name:'Clear terminal', hint:'', icon:'⌫', color:'#9a9aa3', run: () => this.clearActive() },
      { name:'Lock now', hint:'', icon:'⚿', color:'#ff7a59', run: () => this.lockNow() },
      { name:'Add port forward', hint:'-L', icon:'⇄', color:'#46d9a0', run: () => this.startForward('local') },
      { name:'Add dynamic SOCKS proxy', hint:'-D', icon:'⊝', color:'#bd93f9', run: () => this.startForward('socks') },
      { name:'Add remote forward', hint:'-R', icon:'⇆', color:'#6ea8ff', run: () => this.startForward('remote') },
      { name:'Stop port forwards', hint:'', icon:'⊘', color:'#ff6b78', run: () => this.stopAllForwards() }
    ];
    const hostItems = s.hosts.map(h => ({ name:'Connect — ' + h.name, hint:h.addr, icon:'›', color:'#ff7a59', run: () => this.connectHost(h) }));
    const allItems = [...baseItems, ...hostItems];
    const q = s.paletteQuery.toLowerCase();
    const paletteItems = allItems
      .filter(it => it.name.toLowerCase().includes(q) || (it.hint || '').toLowerCase().includes(q))
      .map(it => ({ name: it.name, hint: it.hint, icon: it.icon, iconColor: it.color, onRun: () => { it.run(); this.setState({ paletteOpen: false }); } }));

    // files
    const joinPath = (a, b) => (a === '/' ? '' : (a || '').replace(/\/+$/, '')) + '/' + b;
    const parentPath = (p) => { const t = (p || '/').replace(/\/+$/, ''); const i = t.lastIndexOf('/'); return i <= 0 ? '/' : t.slice(0, i); };
    const navTo = (side, path) => { if (side === 'local') this.listLocal(path); else this.listRemote(path); };
    const selOf = (side) => (side === 'local' ? s.selLocal : s.selRemote);
    const rowStyle = (isDir, selected) => ({ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '5px', cursor: isDir ? 'pointer' : 'grab', fontSize: '11.5px', color: selected ? '#ededf0' : '#c7c7cf', background: selected ? 'rgba(255,122,89,.14)' : 'transparent' });
    const mkFile = (f, side) => {
      const isDir = f.kind === 'dir';
      const base = side === 'local' ? s.localPath : s.remotePath;
      const selected = selOf(side).includes(f.name);
      return {
        name: f.name, isDir, selected, isUp: false,
        glyph: isDir ? '▸' : '◦', glyphColor: isDir ? '#ff7a59' : '#54545e',
        sub: isDir ? 'dir' : (f.size || ''),
        rowStyle: rowStyle(isDir, selected),
        onClick: (e) => this.onFileClick(side, f, e),
        onDouble: isDir ? () => navTo(side, joinPath(base, f.name)) : null,
        onContext: (e) => this.openFileCtx(side, f, e),
        // Drag the whole selection if this row is part of it, else just this row.
        onDragStart: (e) => {
          const sel = selOf(side);
          const names = sel.includes(f.name) ? sel : [f.name];
          const list = side === 'local' ? s.localFiles : s.remoteFiles;
          const items = list.filter(x => names.includes(x.name)).map(x => ({ name: x.name, kind: x.kind }));
          this._drag = { side, items };
          try {
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('text/plain', names.join(','));
            if (names.length > 1) {
              // Custom drag image: show the count instead of a single filename.
              const ghost = document.createElement('div');
              ghost.textContent = names.length + ' items';
              ghost.style.cssText = 'position:absolute;top:-1000px;left:-1000px;padding:6px 12px;background:#ff7a59;color:#0c0b0a;font:600 12px/1 "JetBrains Mono",ui-monospace,monospace;border-radius:8px;white-space:nowrap;';
              document.body.appendChild(ghost);
              e.dataTransfer.setDragImage(ghost, 12, 12);
              setTimeout(() => ghost.remove(), 0);
            }
          } catch (_) {}
        },
      };
    };
    const upEntry = (side) => ({
      name: '..', isDir: true, isUp: true, selected: false,
      glyph: '↰', glyphColor: '#8b8b95', sub: 'up',
      rowStyle: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '5px', cursor: 'pointer', fontSize: '11.5px', color: '#8b8b95' },
      onClick: () => navTo(side, parentPath(side === 'local' ? s.localPath : s.remotePath)),
      onDouble: null, onDragStart: () => {},
    });

    // connecting
    let connecting = null;
    if (s.connecting) {
      const h = s.connecting.host;
      const labels = ['Resolving ' + h.addr, 'Negotiating ciphers · aes256-gcm', 'Authenticating · publickey', 'Opening shell session'];
      const failed = s.connecting.failed;
      connecting = {
        titleText: failed ? 'Connection failed' : 'Connecting to ' + h.name,
        target: h.user + '@' + h.addr,
        ringStyle: { position:'absolute', width:'30px', height:'30px', borderRadius:'50%', border:'1.5px solid ' + (failed ? 'rgba(255,107,120,.5)' : 'rgba(255,122,89,.5)'), animation:'acaPulse 1.6s ease-out infinite' },
        ring2Style: { position:'absolute', width:'30px', height:'30px', borderRadius:'50%', border:'1.5px solid ' + (failed ? 'rgba(255,107,120,.5)' : 'rgba(255,122,89,.5)'), animation:'acaPulse 1.6s ease-out infinite', animationDelay:'.8s' },
        spinnerStyle: { width:'46px', height:'46px', borderRadius:'50%', border:'2px solid #1f1f27', borderTopColor: failed ? '#ff6b78' : '#ff7a59', animation: failed ? 'none' : 'acaSpin .9s linear infinite' },
        coreStyle: { position:'absolute', width:'12px', height:'12px', background: failed ? '#ff6b78' : '#ff7a59', borderRadius:'3px', transform:'rotate(45deg)' },
        steps: labels.map((l, i) => {
          let st = 'pending';
          if (i < s.connecting.step) st = 'done';
          else if (i === s.connecting.step) st = failed ? 'error' : 'active';
          const glyph = st === 'done' ? '✓' : st === 'error' ? '✕' : '○';
          const glyphColor = st === 'done' ? '#46d9a0' : st === 'error' ? '#ff6b78' : '#3a3a44';
          const labelColor = st === 'done' ? '#8b8b95' : st === 'active' ? '#ededf0' : st === 'error' ? '#ff6b78' : '#54545e';
          return { label: l, active: st === 'active', notActive: st !== 'active', glyph, glyphColor, labelColor };
        })
      };
    }

    // transfer
    const transfer = s.transfer ? {
      name: s.transfer.name,
      arrow: s.transfer.dir === 'up' ? '↑' : '↓',
      queued: s.queue.length,
      pctLabel: Math.round(s.transfer.pct) + '%',
      fillStyle: { height:'100%', width: s.transfer.pct + '%', background:'linear-gradient(90deg,#ff7a59,#ffb38a)', borderRadius:'4px', transition:'width .12s linear' }
    } : null;

    // toasts
    const tColor = (t) => ({ ok:'#46d9a0', err:'#ff6b78', info:'#6ea8ff' }[t] || '#6ea8ff');
    const tIcon = (t) => ({ ok:'✓', err:'✕', info:'i' }[t] || 'i');
    const toasts = s.toasts.map(t => {
      const c = tColor(t.type);
      return {
        title: t.title, msg: t.msg, icon: tIcon(t.type),
        style: { display:'flex', gap:'11px', alignItems:'flex-start', minWidth:'250px', maxWidth:'340px', padding:'12px 14px', background:'#0e0e13', border:'1px solid #23232c', borderLeft:'3px solid ' + c, borderRadius:'9px', boxShadow:'0 16px 44px rgba(0,0,0,.55)', animation:'acaToast .24s cubic-bezier(.2,.8,.2,1)' },
        iconStyle: { width:'18px', height:'18px', borderRadius:'50%', flex:'none', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'11px', fontWeight:'700', color:'#0a0a0b', background:c, marginTop:'1px' }
      };
    });

    const dragBox = (sideKey) => ({ flex:1, minWidth:0, display:'flex', flexDirection:'column', background: s.dragOver === sideKey ? 'rgba(255,122,89,.06)' : 'transparent', border:'1px dashed ' + (s.dragOver === sideKey ? 'rgba(255,122,89,.55)' : '#1c1c24'), borderRadius:'8px', overflow:'hidden', transition:'all .12s ease' });

    // ---------- DASHBOARD ----------
    const folderNames = [];
    s.hosts.forEach(h => { if (!folderNames.includes(h.folder)) folderNames.push(h.folder); });
    const folderItemStyle = (on) => ({ display:'flex', alignItems:'center', gap:'9px', padding:'7px 9px', borderRadius:'6px', cursor:'pointer', fontSize:'12px', color: on ? '#ededf0' : '#9a9aa3', background: on ? '#15151b' : 'transparent', border:'1px solid ' + (on ? '#26262e' : 'transparent') });
    const allActive = s.activeFolder === 'all';
    const allFolder = { count: s.hosts.length, active: allActive, style: folderItemStyle(allActive), onSelect: () => this.setFolder('all') };
    const folderColorOf = (name) => { const m = s.folderMeta[name]; return (m && m.color) || '#ff7a59'; };
    const folders = folderNames.map(name => {
      const on = s.activeFolder === name;
      const meta = s.folderMeta[name] || {};
      const color = folderColorOf(name);
      return {
        name, count: s.hosts.filter(h => h.folder === name).length, active: on, favorite: !!meta.favorite, color,
        style: folderItemStyle(on), countColor: on ? color : '#54545e',
        onSelect: () => this.setFolder(name), onToggleFav: () => this.toggleFolderFav(name), onEdit: () => this.openFolderEdit(name),
      };
    });
    folders.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));

    const tagSet = [];
    s.hosts.forEach(h => h.tags.forEach(t => { if (!tagSet.includes(t)) tagSet.push(t); }));
    const tagChipStyle = (on) => ({ padding:'5px 11px', borderRadius:'20px', cursor:'pointer', fontSize:'11px', color: on ? '#ff7a59' : '#9a9aa3', background: on ? 'rgba(255,122,89,.1)' : '#101015', border:'1px solid ' + (on ? 'rgba(255,122,89,.45)' : '#20202a') });
    const allTags = tagSet.map(t => { const on = s.activeTags.includes(t); return { name: t, active: on, style: tagChipStyle(on), onToggle: () => this.toggleTag(t) }; });

    const dq = s.search.trim().toLowerCase();
    const matchHost = (h) => {
      if (s.activeFolder !== 'all' && h.folder !== s.activeFolder) return false;
      if (s.activeTags.length && !s.activeTags.some(t => h.tags.includes(t))) return false;
      if (dq) { const hay = (h.name + ' ' + h.user + ' ' + h.addr + ' ' + h.folder + ' ' + h.tags.join(' ')).toLowerCase(); if (!hay.includes(dq)) return false; }
      return true;
    };
    const filtered = s.hosts.filter(matchHost);
    const authIconOf = (a) => a === 'key' ? '⚿' : a === 'agent' ? '◈' : '•••';
    const authLabelOf = (a) => a === 'key' ? 'key' : a === 'agent' ? 'agent' : 'password';
    const mkCard = (h) => {
      const isNew = s.newHostId === h.id;
      const isTeam = (h.tags || []).includes('team'); // imported from a Team — highlight distinctly
      return {
        id: h.id, name: h.name, target: h.user + '@' + h.addr, port: h.port, folder: h.folder, lastUsed: h.lastUsed,
        authIcon: authIconOf(h.auth), authLabel: authLabelOf(h.auth), isTeam,
        presence: (this.state.teamPresence || {})[h.connId] || [],
        onPresence: (e) => { e.stopPropagation(); this.setState({ presenceModal: { teamId: h.teamId, name: h.name, presence: (this.state.teamPresence || {})[h.connId] || [] } }); },
        tags: h.tags.map(t => ({ name: t })),
        dotStyle: { width:'8px', height:'8px', borderRadius:'50%', flex:'none', background: h.online ? '#46d9a0' : '#3a3a44', boxShadow: h.online ? '0 0 7px rgba(70,217,160,.6)' : 'none' },
        cardStyle: { position:'relative', display:'flex', flexDirection:'column', gap:'9px', padding:'14px 15px', background: isNew ? '#15130f' : '#0d0d11', border:'1px solid ' + (isNew ? 'rgba(255,122,89,.55)' : isTeam ? 'rgba(70,217,160,.5)' : '#1c1c24'), boxShadow: isTeam ? 'inset 3px 0 0 rgba(70,217,160,.85)' : 'none', borderRadius:'11px', cursor:'pointer', transition:'border-color .15s ease, transform .15s ease', animation: isNew ? 'acaRise .35s ease' : 'none' },
        onConnect: () => this.connectHost(h),
        onEdit: (e) => { e.stopPropagation(); void this.openEditHost(h); },
        onCopy: (e) => { e.stopPropagation(); this.copyCommand(h); },
        onExport: (e) => { e.stopPropagation(); this.exportHost(h); },
        isLocal: !h.connId, // not yet synced to a team/vault
        onSaveVault: (e) => { e.stopPropagation(); void this.saveToVault(h); },
        favorite: !!h.favorite,
        onToggleFav: (e) => { e.stopPropagation(); this.toggleHostFav(h.id); },
      };
    };
    // Favourite connections float into a group at the top; the rest group by folder.
    const favHosts = filtered.filter(h => h.favorite);
    const restHosts = filtered.filter(h => !h.favorite);
    const groupNames = [];
    restHosts.forEach(h => { if (!groupNames.includes(h.folder)) groupNames.push(h.folder); });
    const folderGroups = groupNames.map(name => ({ folder: name, color: folderColorOf(name), count: restHosts.filter(h => h.folder === name).length, cards: restHosts.filter(h => h.folder === name).map(mkCard) }));
    const groups = favHosts.length
      ? [{ folder: '★ Favorites', color: '#ffcf5c', count: favHosts.length, cards: favHosts.map(mkCard) }, ...folderGroups]
      : folderGroups;

    // ---------- ADD HOST FORM ----------
    const f = s.form;
    const segStyle = (on) => ({ flex:1, textAlign:'center', padding:'9px', borderRadius:'7px', cursor:'pointer', fontSize:'12px', color: on ? '#0c0b0a' : '#b9b9c2', background: on ? '#ff7a59' : '#101015', border:'1px solid ' + (on ? '#ff7a59' : '#20202a'), fontWeight: on ? '600' : '400', transition:'all .12s ease' });
    const subSegStyle = (on) => ({ flex:1, textAlign:'center', padding:'7px', borderRadius:'6px', cursor:'pointer', fontSize:'11.5px', color: on ? '#ededf0' : '#8b8b95', background: on ? '#1a1a20' : 'transparent', border:'1px solid ' + (on ? '#2c2c36' : 'transparent') });
    const keyVal = this.validateKey(f.keyText);
    const keyStateColor = keyVal.state === 'valid' ? '#46d9a0' : keyVal.state === 'error' ? '#ff6b78' : '#6a6a74';
    const keyStateIcon = keyVal.state === 'valid' ? '✓' : keyVal.state === 'error' ? '✕' : '○';
    const keyBlocks = f.auth === 'key' && f.keyMode === 'text' && f.keyText.trim() && keyVal.state === 'error';
    const canSaveHost = !!(f.name.trim() && f.host.trim()) && !keyBlocks;

    // ---------- SETTINGS ----------
    const st = s.settings;
    const toggleTrackStyle = (on) => ({ width:'38px', height:'22px', borderRadius:'11px', background: on ? '#ff7a59' : '#26262e', position:'relative', cursor:'pointer', transition:'background .15s ease', flex:'none' });
    const toggleKnobStyle = (on) => ({ position:'absolute', top:'2px', left: on ? '18px' : '2px', width:'18px', height:'18px', borderRadius:'50%', background:'#fff', transition:'left .15s ease' });
    const themeOptions = Object.keys(this.THEMES).map(id => { const th = this.THEMES[id]; const on = id === s.themeId; return { id, name: th.name, active: on, dotStyle: { width:'12px', height:'12px', borderRadius:'4px', background: th.accent, flex:'none' }, style: { display:'flex', alignItems:'center', gap:'8px', padding:'8px 10px', borderRadius:'7px', cursor:'pointer', fontSize:'12px', color: on ? '#ededf0' : '#9a9aa3', background: on ? '#15151b' : '#0e0e12', border:'1px solid ' + (on ? 'rgba(255,122,89,.4)' : '#1c1c24') }, onPick: () => { this.setState({ themeId: id }); } }; });

    return {
      themeVars: themeVars(theme),
      noHosts: s.hosts.length === 0,
      tourSeen: s.tourSeen, tourStep: s.tourStep,
      tourNext: () => this.setState((st) => ({ tourStep: st.tourStep + 1 })),
      tourBack: () => this.setState((st) => ({ tourStep: Math.max(0, st.tourStep - 1) })),
      tourDone: () => this.setState({ tourSeen: true, tourStep: 0 }),
      sidebarOpen: s.sidebarOpen, sftpOpen: s.sftpOpen, paletteOpen: s.paletteOpen, themesOpen: s.themesOpen,
      paletteQuery: s.paletteQuery, paletteRef: this.paletteRef, paletteItems,
      tabs, panes, tabPanes, paneWrapRef: this.paneWrap,
      paneWrapStyle: { flex:1, minWidth:0, minHeight:0, display:'flex', flexDirection: layout === 'row' ? 'row' : 'column', gap:'8px' },
      themesList, themesCount: Object.keys(this.THEMES).length,
      localFiles: [upEntry('local'), ...s.localFiles.map(f => mkFile(f, 'local'))],
      remoteFiles: [upEntry('remote'), ...s.remoteFiles.map(f => mkFile(f, 'remote'))],
      localColStyle: dragBox('local'), remoteColStyle: dragBox('remote'),
      localPath: s.localPath || '~', remotePath: s.remotePath || '/', sftpHost: activeTab ? activeTab.title : '',
      sftpReady: s.sftpStatus === 'ready', sftpMsg: s.sftpErr || (s.sftpStatus === 'connecting' ? 'Connecting…' : 'Not connected'),
      sftpMkdir: () => this.sftpMkdirStart(), sftpRename: () => this.sftpRenameStart(), sftpDelete: () => this.sftpDeleteStart(),
      sftpPrompt: s.sftpPrompt,
      sftpPromptTitle: s.sftpPrompt ? (s.sftpPrompt.mode === 'mkdir' ? 'New folder' : s.sftpPrompt.mode === 'rename' ? 'Rename' : 'Delete ' + (s.sftpPrompt.names ? s.sftpPrompt.names.length : 0) + ' item(s)?') : '',
      onSftpPromptValue: (e) => this.setState(st => ({ sftpPrompt: st.sftpPrompt ? { ...st.sftpPrompt, value: e.target.value } : null })),
      sftpPromptSubmit: () => this.sftpPromptSubmit(), sftpPromptCancel: () => this.sftpPromptCancel(),
      transferActive: !!transfer, transfer,
      conflictOpen: !!s.conflict,
      conflictName: s.conflict ? s.conflict.file.name : '',
      conflictDest: s.conflict ? (s.conflict.dir === 'up' ? s.remotePath : s.localPath) : '',
      conflictAll: s.conflictAll,
      toggleConflictAll: () => this.setState(st => ({ conflictAll: !st.conflictAll })),
      conflictReplace: () => this.resolveConflict('replace'),
      conflictSkip: () => this.resolveConflict('skip'),
      connectingActive: !!connecting, connecting,
      connectingCardStyle: { width:'420px', maxWidth:'90%', background:'#0c0c10', border:'1px solid #26262e', borderRadius:'15px', padding:'28px', boxShadow:'0 36px 90px rgba(0,0,0,.65)', animation: (s.connecting && s.connecting.failed) ? 'acaShake .5s ease' : 'acaModal .18s cubic-bezier(.2,.8,.2,1)' },
      toasts,
      statusTheme: theme.name, statusHost: activeTab ? (activeTab.user + '@' + activeTab.addr) : '',
      // Per-tab autocomplete toggle surfaced in the status bar.
      statusSuggestOn: this.tabSuggestOn(activeTab),
      toggleTabSuggest: () => this.toggleTabSuggest(),
      onDragOver: (e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {} },
      onDropRemote: (e) => { e.preventDefault(); this.sftpDrop('remote'); },
      onDropLocal: (e) => { e.preventDefault(); this.sftpDrop('local'); },
      onDragEnterRemote: () => this.setState({ dragOver: 'remote' }),
      onDragEnterLocal: () => this.setState({ dragOver: 'local' }),
      onDragLeave: () => {},
      toggleSidebar: () => this.setState(st => ({ sidebarOpen: !st.sidebarOpen })),
      winMin: () => this.winAction('min'), winMax: () => this.winAction('max'), winClose: () => this.winAction('close'),
      toggleSftp: () => this.toggleSftp(),
      sftpW: s.sftpW,
      onSftpGutterDown: (e) => this.startSftpResize(e),
      sftpCtx: s.sftpCtx,
      closeFileCtx: () => this.closeFileCtx(),
      ctxOpen: (side, name, isDir) => this.openFileExternal(side, name, isDir),
      ctxReveal: () => this.revealLocal(),
      sftpMax: s.sftpMax,
      toggleSftpMax: () => this.setState(st => ({ sftpMax: !st.sftpMax })),
      openPalette: () => this.setState({ paletteOpen: true, paletteQuery: '' }),
      closePalette: () => this.setState({ paletteOpen: false }),
      setPaletteQuery: (e) => this.setState({ paletteQuery: e.target.value }),
      openThemes: () => this.setState({ themesOpen: true }),
      closeThemes: () => this.setState({ themesOpen: false }),
      aboutOpen: s.aboutOpen,
      openAbout: () => this.setState({ aboutOpen: true }),
      closeAbout: () => this.setState({ aboutOpen: false }),
      whatsNewOpen: s.whatsNewOpen,
      openWhatsNew: () => this.setState({ whatsNewOpen: true, aboutOpen: false, paletteOpen: false }),
      closeWhatsNew: () => this.setState({ whatsNewOpen: false }),
      changelog: CHANGELOG,
      author: AUTHOR, openExt,
      newTab: () => this.newTab(),
      splitRight: this.splitRight, splitDown: this.splitDown,
      cancelConnect: this.cancelConnect,
      secretPromptOpen: !!s.secretPrompt,
      secretPromptTitle: s.secretPrompt ? ('Connect to ' + s.secretPrompt.host.name) : '',
      secretPromptLabel: s.secretPrompt && s.secretPrompt.kind === 'key' ? 'Key passphrase' : 'Password',
      secretPromptHint: s.secretPrompt && s.secretPrompt.kind === 'key' ? 'Blank if your key has no passphrase. Never written to disk.' : 'Used for this connection only. Never written to disk.',
      secretValue: s.secretPrompt ? s.secretPrompt.value : '',
      onSecretInput: (e) => this.setState(st => ({ secretPrompt: st.secretPrompt ? { ...st.secretPrompt, value: e.target.value } : null })),
      onSecretKey: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.submitSecret(); } },
      submitSecret: () => this.submitSecret(), cancelSecret: () => this.cancelSecret(),
      hostKeyOpen: !!s.hostKeyPrompt,
      hostKeyName: s.hostKeyPrompt ? s.hostKeyPrompt.host.name : '',
      hostKeyTarget: s.hostKeyPrompt ? (s.hostKeyPrompt.host.user + '@' + s.hostKeyPrompt.host.addr + ':' + (s.hostKeyPrompt.host.port || '22')) : '',
      hostKeyFp: s.hostKeyPrompt ? s.hostKeyPrompt.fp : '',
      acceptHostKey: this.acceptHostKey, rejectHostKey: this.rejectHostKey,
      confirmCloseOpen: !!s.confirmClose,
      confirmCloseName: s.confirmClose ? s.confirmClose.name : '',
      confirmCloseTab: () => this.confirmCloseTab(),
      cancelConfirmClose: () => this.setState({ confirmClose: null }),

      // view nav
      isDashboard: s.view === 'dashboard', isWorkspace: s.view === 'workspace',
      sessionCount: s.tabs.length,
      navDashStyle: folderItemStyle(s.view === 'dashboard'),
      navTermStyle: folderItemStyle(s.view === 'workspace'),
      goDashboard: () => this.setView('dashboard'),
      goTerminal: () => this.setView('workspace'),
      isTeams: s.view === 'teams',
      navTeamsStyle: folderItemStyle(s.view === 'teams'),
      goTeams: () => this.setView('teams'),
      teamNudge: !s.settings.teamNudgeDismissed,
      dismissTeamNudge: () => this.setState(st => ({ settings: { ...st.settings, teamNudgeDismissed: true } })),
      teamsDefaults: { email: s.settings.teamsEmail || '' },

      // dashboard
      allFolder, folders, allTags, groups,
      totalHosts: s.hosts.length, filteredCount: filtered.length, dashEmpty: filtered.length === 0,
      hasTags: tagSet.length > 0,
      searchValue: s.search, onSearch: (e) => this.setSearch(e.target.value), clearSearch: () => this.setSearch(''),
      activeFolderLabel: s.activeFolder === 'all' ? 'All connections' : s.activeFolder,
      folderEditOpen: !!s.folderEdit,
      folderEditName: s.folderEdit ? s.folderEdit.newName : '',
      folderEditColor: s.folderEdit ? s.folderEdit.color : '',
      folderEditFav: s.folderEdit ? !!s.folderEdit.favorite : false,
      onFolderEditName: (e) => this.setFolderEdit('newName', e.target.value),
      pickFolderColor: (c) => this.setFolderEdit('color', c),
      toggleFolderEditFav: () => this.setFolderEdit('favorite', !(this.state.folderEdit && this.state.folderEdit.favorite)),
      saveFolderEdit: () => this.saveFolderEdit(),
      cancelFolderEdit: () => this.setState({ folderEdit: null }),
      folderPalette: ['#ff7a59', '#ffcf5c', '#46d9a0', '#6ea8ff', '#bd93f9', '#ff6b78', '#f5c2e7', '#88c0d0'],

      // add host
      addHostOpen: s.addHostOpen, openAddHost: () => this.openAddHost(), closeAddHost: () => this.closeAddHost(),
      isEditing: !!s.editingId,
      modalTitle: s.editingId ? 'Edit connection' : 'New connection',
      modalSubtitle: s.editingId ? 'Changes are saved locally to this device' : 'Saved locally — credentials never leave this device',
      saveLabel: s.editingId ? 'Save changes' : 'Create host',
      deleteHost: () => this.deleteHost(s.editingId),
      fName: f.name, fHost: f.host, fPort: f.port, fUser: f.user,
      fPassword: f.password, fKeyPath: f.keyPath, fKeyText: f.keyText, fPassphrase: f.passphrase, fFolder: f.folder, fTagInput: f.tagInput,
      fJumpHost: f.jumpHost || '',
      // Other saved hosts, eligible as a jump (bastion) host for this one.
      jumpOptions: s.hosts.filter(h => h.id !== s.editingId).map(h => ({ id: h.id, label: (h.name || h.addr) + ' · ' + (h.user || 'root') + '@' + h.addr })),
      onFJumpHost: (e) => this.setField('jumpHost', e.target.value),
      fSnippet: f.snippet || '',
      onFSnippet: (e) => this.setField('snippet', e.target.value),
      fTags: f.tags.map(t => ({ name: t, onRemove: () => this.removeTag(t) })),
      authIsPassword: f.auth === 'password', authIsKey: f.auth === 'key', authIsAgent: f.auth === 'agent',
      authPwStyle: segStyle(f.auth === 'password'), authKeyStyle: segStyle(f.auth === 'key'), authAgentStyle: segStyle(f.auth === 'agent'),
      setAuthPassword: () => this.setField('auth', 'password'), setAuthKey: () => this.setField('auth', 'key'), setAuthAgent: () => this.setField('auth', 'agent'),
      keyModeFile: f.keyMode === 'file', keyModeText: f.keyMode === 'text',
      keyFileStyle: subSegStyle(f.keyMode === 'file'), keyTextStyle: subSegStyle(f.keyMode === 'text'),
      setKeyModeFile: () => this.setField('keyMode', 'file'), setKeyModeText: () => this.setField('keyMode', 'text'),
      // Key Vault: a 3rd key source (pick a saved key) + "save this pasted key" name field.
      keyModeVault: f.keyMode === 'vault', keyVaultStyle: subSegStyle(f.keyMode === 'vault'),
      setKeyModeVault: () => this.setField('keyMode', 'vault'),
      vaultKeyOptions: s.vaultKeys.map(k => ({ id: k.id, label: k.name + ' · ' + k.label })),
      fVaultKeyId: f.vaultKeyId || '',
      onPickVaultKey: (e) => { const id = e.target.value; if (id) void this.pickVaultKey(id); else this.setField('vaultKeyId', ''); },
      fSaveKeyName: f.saveKeyName || '',
      onFSaveKeyName: (e) => this.setField('saveKeyName', e.target.value),
      openKeys: () => this.setState({ keysOpen: true, addHostOpen: false }),
      onFKeyText: (e) => this.setField('keyText', e.target.value),
      keyShowStatus: f.keyText.trim().length > 0,
      keyStatusIcon: keyStateIcon, keyStatusMsg: keyVal.message,
      keyStatusStyle: { display:'flex', alignItems:'center', gap:'7px', marginTop:'8px', fontSize:'11px', color: keyStateColor },
      keyIconStyle: { width:'15px', height:'15px', borderRadius:'50%', flex:'none', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'9px', fontWeight:'700', color:'#0a0a0b', background: keyStateColor },
      keyTextAreaStyle: { width:'100%', minHeight:'108px', resize:'vertical', background:'#0e0e12', border:'1px solid ' + (keyVal.state === 'error' && f.keyText.trim() ? 'rgba(255,107,120,.5)' : keyVal.state === 'valid' ? 'rgba(70,217,160,.4)' : '#20202a'), borderRadius:'8px', padding:'11px 13px', color:'#ededf0', font:'inherit', fontSize:'11.5px', lineHeight:'1.5', outline:'none' },
      onFName: (e) => this.setField('name', e.target.value),
      onFHost: (e) => this.setField('host', e.target.value),
      onFPort: (e) => this.setField('port', e.target.value),
      onFUser: (e) => this.setField('user', e.target.value),
      onFPassword: (e) => this.setField('password', e.target.value),
      onFKeyPath: (e) => this.setField('keyPath', e.target.value),
      onFPassphrase: (e) => this.setField('passphrase', e.target.value),
      onFFolder: (e) => this.setField('folder', e.target.value),
      onFTagInput: (e) => this.setField('tagInput', e.target.value),
      onFTagKey: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.addTagFromInput(); } },
      onBrowseKey: async () => {
        if (!isTauri) { this.setField('keyPath', '~/.ssh/id_ed25519'); return; }
        const { open } = await import('@tauri-apps/plugin-dialog');
        const p = await open({ multiple: false, title: 'Choose SSH private key', defaultPath: '~/.ssh' });
        if (typeof p === 'string') this.setField('keyPath', p);
      },
      folderChips: folderNames.map(name => ({ name, onPick: () => this.setField('folder', name) })),
      saveHost: () => this.saveHost(), canSaveHost,
      saveHostStyle: { padding:'10px 20px', borderRadius:'8px', border:'none', font:'inherit', fontSize:'12.5px', fontWeight:'600', cursor: canSaveHost ? 'pointer' : 'not-allowed', color:'#0c0b0a', background: canSaveHost ? '#ff7a59' : '#3a3024', opacity: canSaveHost ? '1' : '.55' },

      // settings
      settingsOpen: s.settingsOpen, openSettings: () => this.openSettings(), closeSettings: () => this.closeSettings(),
      themeOptions,
      fontSize: st.fontSize, fontSizeLabel: st.fontSize + 'px', onFontSize: (e) => this.setSetting('fontSize', parseInt(e.target.value, 10)),
      cursorBlockStyle: segStyle(st.cursor === 'block'), cursorBarStyle: segStyle(st.cursor === 'bar'), cursorUnderStyle: segStyle(st.cursor === 'underline'),
      setCursorBlock: () => this.setSetting('cursor', 'block'), setCursorBar: () => this.setSetting('cursor', 'bar'), setCursorUnder: () => this.setSetting('cursor', 'underline'),
      scrollback: st.scrollback, onScrollback: (e) => this.setSetting('scrollback', e.target.value),
      cmdSuggestTrack: toggleTrackStyle(!!st.cmdSuggest), cmdSuggestKnob: toggleKnobStyle(!!st.cmdSuggest),
      toggleCmdSuggest: () => this.setSetting('cmdSuggest', !st.cmdSuggest),
      triggers: st.triggers || [],
      triggerDraft: s.triggerDraft, triggerColor: s.triggerColor,
      onTriggerDraft: (e) => this.setState({ triggerDraft: e.target.value }),
      onTriggerColor: (e) => this.setState({ triggerColor: e.target.value }),
      addTrigger: () => { this.addTrigger(this.state.triggerDraft, this.state.triggerColor); this.setState({ triggerDraft: '' }); },
      removeTrigger: (id) => this.removeTrigger(id),
      toggleTriggerNotify: (id) => this.toggleTriggerField(id, 'notify'),
      toggleTriggerHighlight: (id) => this.toggleTriggerField(id, 'highlight'),
      confirmCloseTrack: toggleTrackStyle(st.confirmClose), confirmCloseKnob: toggleKnobStyle(st.confirmClose), toggleConfirmClose: () => this.setSetting('confirmClose', !st.confirmClose),
      restoreTabsTrack: toggleTrackStyle(st.restoreTabs), restoreTabsKnob: toggleKnobStyle(st.restoreTabs), toggleRestoreTabs: () => this.setSetting('restoreTabs', !st.restoreTabs),
      lockIdleTrack: toggleTrackStyle(st.lockIdle), lockIdleKnob: toggleKnobStyle(st.lockIdle),
      toggleLockIdle: () => { const c = this.state.settings; if (!c.lockIdle) { if (c.lockHash) this.setSetting('lockIdle', true); else this.setState({ lockPrompt: { mode: 'set', value: '' } }); } else this.setSetting('lockIdle', false); },
      locked: s.locked, unlockValue: s.unlockValue,
      onUnlockInput: (e) => this.setState({ unlockValue: e.target.value }),
      onUnlockKey: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.tryUnlock(this.state.unlockValue); } },
      submitUnlock: () => this.tryUnlock(this.state.unlockValue),
      lockSetOpen: !!(s.lockPrompt && s.lockPrompt.mode === 'set'),
      lockSetValue: s.lockPrompt ? s.lockPrompt.value : '',
      onLockSetInput: (e) => this.setState(st0 => ({ lockPrompt: st0.lockPrompt ? { ...st0.lockPrompt, value: e.target.value } : null })),
      onLockSetKey: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.hashAndSetLock(this.state.lockPrompt ? this.state.lockPrompt.value : ''); } },
      submitLockSet: () => this.hashAndSetLock(this.state.lockPrompt ? this.state.lockPrompt.value : ''),
      cancelLockSet: () => this.setState({ lockPrompt: null }),
      fwdOpen: !!s.fwdPrompt,
      fwdMode: s.fwdPrompt ? (s.fwdPrompt.mode || 'local') : 'local',
      fwdLocal: s.fwdPrompt ? s.fwdPrompt.localPort : '',
      fwdRemoteHost: s.fwdPrompt ? s.fwdPrompt.remoteHost : '',
      fwdRemotePort: s.fwdPrompt ? s.fwdPrompt.remotePort : '',
      onFwdLocal: (e) => this.setFwd('localPort', e.target.value),
      onFwdRemoteHost: (e) => this.setFwd('remoteHost', e.target.value),
      onFwdRemotePort: (e) => this.setFwd('remotePort', e.target.value),
      submitForward: () => this.submitForward(),
      cancelForward: () => this.setState({ fwdPrompt: null }),
      forwardCount: s.forwards.length,
      broadcast: s.broadcast,
      toggleBroadcast: () => this.toggleBroadcast(),
      mcpOpen: s.mcpOpen, mcpRunning: s.mcpRunning, mcpUrl: MCP_URL, mcpToken: s.settings.mcpToken || '',
      mcpLog: s.mcpLog, mcpExposedCount: s.hosts.filter(h => h.agentAllowed).length,
      mcpHosts: s.hosts.map(h => ({ id: h.id, name: h.name, target: h.user + '@' + h.addr, allowed: !!h.agentAllowed, auto: !!h.agentAutoAllow, onToggle: () => this.toggleHostAgent(h.id), onToggleAuto: () => this.toggleHostAgentAuto(h.id) })),
      mcpConfig: JSON.stringify({ mcpServers: { sshache: { url: MCP_URL, headers: { Authorization: 'Bearer ' + (s.settings.mcpToken || '<token>') } } } }, null, 2),
      openMcp: () => this.openMcp(), closeMcp: () => this.setState({ mcpOpen: false }), toggleMcp: () => this.toggleMcp(),
      copyMcp: (text) => { try { navigator.clipboard.writeText(text).then(() => this.pushToast({ type: 'ok', title: 'Copied', msg: '' })).catch(() => {}); } catch (e) {} },
      approvalOpen: !!s.approvalReq,
      approvalHost: s.approvalReq ? s.approvalReq.host : '',
      approvalCommand: s.approvalReq ? s.approvalReq.command : '',
      approve: () => this.mcpRespond(true), deny: () => this.mcpRespond(false),
      onExport: () => this.exportConfig(),
      onImport: () => this.importConfig(),
      onImportOne: () => this.importHostFile(),
      clearConfirmOpen: s.clearConfirm,
      openClearConfirm: () => this.setState({ clearConfirm: true }),
      cancelClearConfirm: () => this.setState({ clearConfirm: false }),
      doClearAll: () => this.clearAllData(),
      appVersion: s.appVersion,
      updateInfo: s.update,
      updateChecking: s.updateChecking,
      doCheckUpdate: () => this.checkUpdate(true),
      doDownloadUpdate: () => this.downloadUpdate(),
      ioOpen: !!s.ioPrompt,
      ioTitle: s.ioPrompt ? ({ export: 'Export — encrypt with a password', export1: 'Export connection — optional password', import1: 'Import connection', import: 'Import — enter the password' }[s.ioPrompt.mode] || 'Import') : '',
      ioLabel: s.ioPrompt ? (s.ioPrompt.mode === 'export' ? 'New password' : 'Password') : '',
      ioHint: s.ioPrompt ? ({ export: 'The backup (hosts + saved secrets) is encrypted with this password — you’ll need it to import.', export1: 'Leave blank to export as plain JSON. With a password, the file (connection + its secret) is AES-256-GCM encrypted.', import1: 'Enter the password only if this connection file was exported with one — otherwise leave it blank.', import: 'Enter the password used when this file was exported.' }[s.ioPrompt.mode] || '') : '',
      ioCta: s.ioPrompt ? ({ export: 'Choose file & export', export1: 'Choose file & export', import1: 'Import connection', import: 'Import' }[s.ioPrompt.mode] || 'Import') : '',
      ioValue: s.ioPrompt ? s.ioPrompt.value : '',
      onIoInput: (e) => this.setState(st => ({ ioPrompt: st.ioPrompt ? { ...st.ioPrompt, value: e.target.value } : null })),
      onIoKey: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.ioSubmit(); } },
      ioSubmit: () => this.ioSubmit(), ioCancel: () => this.ioCancel(),

      stop: (e) => e.stopPropagation()
    };
  }

  render() {
    const v = this.renderVals();
    return (
      <div style={{ ...css("position:relative;height:100vh;width:100%;display:flex;flex-direction:column;background:#09090b;color:#ededf0;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;overflow:hidden;"), ...v.themeVars }}>

        {/* TITLE BAR */}
        <div data-tauri-drag-region style={css("height:42px;flex:none;display:flex;align-items:center;gap:12px;padding:0 12px;" + (isMac ? "padding-left:80px;" : "") + "background:#0a0a0d;border-bottom:1px solid #16161c;")}>
          <div style={css("display:flex;align-items:center;gap:9px;")}>
            <img src={logoMark} width="20" height="20" alt="SSH Ache" style={{ borderRadius: "6px", boxShadow: "0 0 12px rgba(255,77,112,.45)" }} />
            <span style={css("font-weight:700;font-size:13px;letter-spacing:.01em;color:#f2f2f5;")}>SSH&nbsp;Ache</span>
            <span style={css("font-size:10px;color:#6a6a74;border:1px solid #26262e;border-radius:4px;padding:1px 5px;")}>v{v.appVersion}</span>
            {v.updateInfo && (<Hov onClick={v.doDownloadUpdate} title={"Download v" + v.updateInfo.version} s="font-size:10px;color:#0c0b0a;background:#ff7a59;border-radius:4px;padding:2px 7px;cursor:pointer;font-weight:600;" h="background:#ff8d70;">↑ Update</Hov>)}
          </div>
          <span data-tauri-drag-region style={css("flex:1;")}></span>
          <div style={css("display:flex;align-items:center;gap:7px;")}>
            <Hov onClick={v.openPalette} s="display:flex;align-items:center;gap:7px;padding:5px 9px;background:#101015;border:1px solid #20202a;border-radius:6px;cursor:pointer;color:#9a9aa3;font-size:11px;" h="background:#15151b;color:#ededf0;">
              <span>Search &amp; commands</span><span style={css("border:1px solid #2c2c36;border-radius:3px;padding:0 4px;color:#6a6a74;")}>⌘K</span>
            </Hov>
            <Hov onClick={v.openThemes} title="Themes" s="display:flex;align-items:center;gap:4px;padding:6px 9px;background:#101015;border:1px solid #20202a;border-radius:6px;cursor:pointer;" h="background:#15151b;">
              <span style={css("width:9px;height:9px;border-radius:50%;background:#ff7a59;")}></span>
              <span style={css("width:9px;height:9px;border-radius:50%;background:#6ea8ff;margin-left:-4px;")}></span>
              <span style={css("width:9px;height:9px;border-radius:50%;background:#46d9a0;margin-left:-4px;")}></span>
            </Hov>
            <Hov onClick={v.toggleSftp} title="SFTP" s="padding:6px 10px;background:#101015;border:1px solid #20202a;border-radius:6px;cursor:pointer;color:#b9b9c2;font-size:11px;" h="background:#15151b;color:#ededf0;">⇅&nbsp;SFTP</Hov>
            <Hov onClick={v.openAbout} title="About · support the author" s="width:32px;height:28px;display:flex;align-items:center;justify-content:center;background:#101015;border:1px solid #20202a;border-radius:6px;cursor:pointer;" h="background:#15151b;border-color:rgba(255,95,109,.4);">
              <svg width="15" height="15" viewBox="0 0 24 24" className="aca-heart" aria-hidden="true">
                <defs><linearGradient id="acaHeartGrad" x1="2" y1="3" x2="22" y2="21" gradientUnits="userSpaceOnUse"><stop stopColor="#ff8a63"/><stop offset="1" stopColor="#ff3d7f"/></linearGradient></defs>
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" fill="url(#acaHeartGrad)"/>
              </svg>
            </Hov>
          </div>
          {!isMac && (
          <div style={css("display:flex;gap:3px;margin-left:4px;align-items:center;")}>
            <Hov onClick={v.winMin} title="Minimize" s="width:26px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:5px;cursor:pointer;" h="background:#15151b;">
              <span style={css("width:11px;height:1.5px;background:#8b8b95;")}></span>
            </Hov>
            <Hov onClick={v.winMax} title="Maximize" s="width:26px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:5px;cursor:pointer;" h="background:#15151b;">
              <span style={css("width:9px;height:9px;border:1.5px solid #8b8b95;border-radius:2px;")}></span>
            </Hov>
            <Hov onClick={v.winClose} title="Close" s="width:26px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:5px;cursor:pointer;" h="background:rgba(244,88,78,.9);">
              <span style={css("position:relative;width:11px;height:11px;")}>
                <span style={css("position:absolute;top:5px;left:0;width:11px;height:1.5px;background:#cfcfd6;transform:rotate(45deg);")}></span>
                <span style={css("position:absolute;top:5px;left:0;width:11px;height:1.5px;background:#cfcfd6;transform:rotate(-45deg);")}></span>
              </span>
            </Hov>
          </div>
          )}
        </div>

        {/* BODY */}
        <div style={css("flex:1;min-height:0;display:flex;")}>

          {/* SIDEBAR */}
          {v.sidebarOpen && (
            <div style={css("width:224px;flex:none;background:#0a0a0d;border-right:1px solid #16161c;display:flex;flex-direction:column;")}>
              <div style={css("padding:11px 10px 4px;display:flex;flex-direction:column;gap:3px;")}>
                <div onClick={v.goDashboard} style={v.navDashStyle}>
                  <span style={css("font-size:13px;flex:none;width:16px;text-align:center;")}>⊞</span>
                  <span style={css("flex:1;")}>Dashboard</span>
                </div>
                <div onClick={v.goTerminal} style={v.navTermStyle}>
                  <span style={css("font-size:12px;flex:none;width:16px;text-align:center;color:#ff7a59;")}>›_</span>
                  <span style={css("flex:1;")}>Terminal</span>
                  <span style={css("font-size:9.5px;color:#54545e;border:1px solid #20202a;border-radius:9px;padding:1px 6px;")}>{v.sessionCount}</span>
                </div>
                <div onClick={v.goTeams} style={v.navTeamsStyle}>
                  <span style={css("font-size:12px;flex:none;width:16px;text-align:center;color:#6ea8ff;")}>◈</span>
                  <span style={css("flex:1;")}>Teams</span>
                </div>
              </div>
              <div style={css("flex:1;overflow:auto;padding:6px 10px 8px;")}>
                <div style={css("font-size:9px;letter-spacing:.14em;color:#46464f;text-transform:uppercase;padding:11px 8px 6px;")}>Folders</div>
                <div onClick={v.allFolder.onSelect} style={v.allFolder.style}>
                  <span style={css("font-size:11px;flex:none;width:16px;text-align:center;color:#6a6a74;")}>≡</span>
                  <span style={css("flex:1;")}>All connections</span>
                  <span style={css("font-size:10px;color:#54545e;")}>{v.allFolder.count}</span>
                </div>
                {v.folders.map((folder) => (
                  <FolderRow key={folder.name} folder={folder} />
                ))}
              </div>
              <div style={css("padding:10px;border-top:1px solid #14141a;display:flex;flex-direction:column;gap:7px;")}>
                <Hov as="button" onClick={v.openAddHost} s="display:flex;align-items:center;justify-content:center;gap:7px;padding:9px;background:#ff7a59;border:none;border-radius:7px;color:#0c0b0a;font:inherit;font-size:12px;font-weight:600;cursor:pointer;" h="background:#ff8d70;">
                  <span style={css("font-size:14px;")}>+</span><span>Add host</span>
                </Hov>
                <div style={css("display:flex;gap:7px;")}>
                  <Hov as="button" onClick={v.openThemes} s="flex:1;padding:7px 8px;background:#101015;border:1px solid #20202a;border-radius:6px;color:#b9b9c2;font:inherit;font-size:11px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Themes</Hov>
                  <Hov as="button" onClick={v.openSettings} s="flex:1;padding:7px 8px;background:#101015;border:1px solid #20202a;border-radius:6px;color:#b9b9c2;font:inherit;font-size:11px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Settings</Hov>
                </div>
              </div>
            </div>
          )}

          {/* MAIN */}
          <div style={css("flex:1;min-width:0;display:flex;flex-direction:column;")}>

            {/* TEAMS */}
            {v.isTeams && (
              <div style={css("flex:1;min-height:0;overflow:auto;padding:24px;")}>
                <TeamsPanel
                  isTauri={isTauri}
                  defaults={v.teamsDefaults}
                  onRemember={(email) => this.rememberTeams(email)}
                  onImport={(args) => this.importTeamHost(args)}
                  onSync={(force) => this.syncAllTeams(force)}
                  onGoDashboard={() => this.setView('dashboard')}
                />
              </div>
            )}

            {/* DASHBOARD */}
            {v.isDashboard && (v.noHosts ? (
              <div style={css("flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:auto;padding:48px 24px;text-align:center;")}>
                <img src={logoMark} width="84" height="84" alt="SSH Ache" className="aca-float" style={{ borderRadius: '24px', boxShadow: '0 0 42px rgba(var(--accent-rgb),.35)' }} />
                <div style={{ ...css("font-size:30px;font-weight:700;margin-top:22px;letter-spacing:-.02em;"), background: 'linear-gradient(120deg,var(--accent-hi),var(--accent))', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Welcome to SSH&nbsp;Ache</div>
                <div style={css("font-size:13px;color:#9a9aa3;margin-top:11px;max-width:460px;line-height:1.65;")}>No connections yet. Add your first server to get started — a fast, secure terminal with SFTP and port forwarding, all on your machine.</div>
                <div style={css("margin-top:26px;display:flex;align-items:center;gap:11px;")}>
                  <Hov as="button" onClick={v.openAddHost} s="display:flex;align-items:center;gap:9px;padding:13px 24px;background:#ff7a59;border:none;border-radius:10px;color:#0c0b0a;font:inherit;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 10px 28px rgba(255,122,89,.28);" h="background:#ff8d70;">
                    <span style={css("font-size:16px;")}>+</span><span>Add your first connection</span>
                  </Hov>
                  <Hov as="button" onClick={v.onImportOne} s="display:flex;align-items:center;gap:8px;padding:13px 20px;background:#101015;border:1px solid #20202a;border-radius:10px;color:#b9b9c2;font:inherit;font-size:13px;cursor:pointer;" h="background:#16161c;color:#ededf0;border-color:#2c2c36;">
                    <span style={css("font-size:14px;")}>⤒</span><span>Import</span>
                  </Hov>
                </div>
                <div style={css("display:flex;flex-wrap:wrap;justify-content:center;gap:9px;margin-top:28px;")}>
                  {[['⌘K', 'Command palette'], ['⌘T', 'Switch theme'], ['⌘J', 'SFTP files'], ['⌘D', 'Split panes']].map((t, i) => (
                    <span key={i} style={css("display:flex;align-items:center;gap:7px;font-size:11px;color:#9a9aa3;background:#0e0e12;border:1px solid #20202a;border-radius:20px;padding:6px 13px;")}><span style={css("color:#ff7a59;font-weight:700;")}>{t[0]}</span>{t[1]}</span>
                  ))}
                </div>
                <div style={css("margin-top:34px;display:flex;align-items:center;flex-wrap:wrap;justify-content:center;gap:10px;font-size:11px;color:#54545e;")}>
                  <span>Crafted by</span>
                  <span onClick={() => v.openExt(v.author.site)} style={css("color:#9a9aa3;cursor:pointer;")}>{v.author.name}</span>
                  <span style={css("color:#26262e;")}>·</span>
                  <span onClick={() => v.openExt(v.author.github)} style={css("color:#9a9aa3;cursor:pointer;")}>GitHub</span>
                  <span style={css("color:#26262e;")}>·</span>
                  <span onClick={() => v.openExt(v.author.tip)} style={css("color:#ff7a59;cursor:pointer;")}>Buy me a coffee ☕</span>
                </div>
              </div>
            ) : (
              <div style={css("flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;")}>
                <div style={css("flex:none;padding:22px 26px 14px;display:flex;align-items:flex-end;gap:14px;")}>
                  <div>
                    <div style={css("font-size:20px;font-weight:700;color:#f2f2f5;letter-spacing:-.01em;")}>{v.activeFolderLabel}</div>
                    <div style={css("font-size:11.5px;color:#6a6a74;margin-top:3px;")}>{v.filteredCount} of {v.totalHosts} connections · stored locally</div>
                  </div>
                  <span style={css("flex:1;")}></span>
                  <Hov as="button" onClick={v.onImportOne} title="Import a connection file" s="display:flex;align-items:center;gap:7px;padding:10px 14px;background:#101015;border:1px solid #20202a;border-radius:8px;color:#b9b9c2;font:inherit;font-size:12.5px;cursor:pointer;" h="background:#16161c;color:#ededf0;border-color:#2c2c36;">
                    <span style={css("font-size:13px;")}>⤒</span><span>Import</span>
                  </Hov>
                  <Hov as="button" onClick={v.openAddHost} s="display:flex;align-items:center;gap:8px;padding:10px 16px;background:#ff7a59;border:none;border-radius:8px;color:#0c0b0a;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;" h="background:#ff8d70;">
                    <span style={css("font-size:15px;")}>+</span><span>New host</span>
                  </Hov>
                </div>
                <div style={css("flex:none;padding:0 26px;")}>
                  <div style={css("display:flex;align-items:center;gap:10px;background:#0d0d11;border:1px solid #20202a;border-radius:9px;padding:11px 14px;")}>
                    <span style={css("color:#54545e;font-size:13px;")}>⌕</span>
                    <input value={v.searchValue} onChange={v.onSearch} placeholder="Search by name, host, folder or tag…" spellCheck={false} style={css("flex:1;background:transparent;border:none;outline:none;color:#ededf0;font:inherit;font-size:13px;")} />
                  </div>
                  {v.hasTags && (
                    <div style={css("display:flex;flex-wrap:wrap;gap:7px;margin-top:13px;")}>
                      {v.allTags.map((tag) => (
                        <div key={tag.name} onClick={tag.onToggle} style={tag.style}>#{tag.name}</div>
                      ))}
                    </div>
                  )}
                </div>
                <div style={css("flex:1;overflow:auto;padding:18px 26px 26px;")}>
                  {v.teamNudge && (
                    <div style={css("display:flex;align-items:center;gap:14px;padding:14px 16px;margin-bottom:20px;border:1px solid rgba(70,217,160,.28);background:linear-gradient(180deg,rgba(70,217,160,.07),rgba(70,217,160,.02));border-radius:11px;")}>
                      <span style={css("font-size:20px;flex:none;")}>👥</span>
                      <div style={css("flex:1;min-width:0;")}>
                        <div style={css("font-size:13px;font-weight:600;color:#ededf0;")}>Working with a team?</div>
                        <div style={css("font-size:11.5px;color:#9a9aa3;margin-top:2px;")}>Share these connections end-to-end encrypted — with live presence, spectating, and one-click revoke.</div>
                      </div>
                      <Hov as="button" onClick={v.goTeams} s="flex:none;padding:9px 15px;background:#46d9a0;border:none;border-radius:8px;color:#062a1c;font:inherit;font-size:12px;font-weight:700;cursor:pointer;" h="filter:brightness(1.06);">Set up Teams</Hov>
                      <Hov onClick={v.dismissTeamNudge} title="Dismiss" s="flex:none;width:24px;height:24px;display:flex;align-items:center;justify-content:center;color:#54545e;border-radius:6px;cursor:pointer;" h="background:#16161c;color:#ededf0;">×</Hov>
                    </div>
                  )}
                  {v.groups.map((group) => (
                    <div key={group.folder} style={css("margin-bottom:24px;")}>
                      <div style={css("display:flex;align-items:center;gap:8px;margin-bottom:12px;")}>
                        <span style={{ fontSize: '11px', letterSpacing: '.04em', color: group.color, textTransform: 'uppercase' }}>{group.folder}</span>
                        <span style={css("font-size:10px;color:#54545e;border:1px solid #20202a;border-radius:9px;padding:0 6px;")}>{group.count}</span>
                        <span style={css("flex:1;height:1px;background:#15151b;")}></span>
                      </div>
                      <div style={css("display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:13px;")}>
                        {group.cards.map((card) => (
                          <Hov key={card.id} className="aca-card" onClick={card.onConnect} s={card.cardStyle} h="border-color:rgba(255,122,89,.55);transform:translateY(-2px);box-shadow:0 8px 22px rgba(0,0,0,.35);">
                            <div style={css("display:flex;align-items:center;gap:9px;min-width:0;")}>
                              <span style={card.dotStyle}></span>
                              <span style={css("flex:1;min-width:0;font-size:14px;font-weight:600;color:#ededf0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{card.name}</span>
                              {card.isTeam && (<span title="Shared by your team" style={css("font-size:8.5px;letter-spacing:.08em;color:#46d9a0;background:rgba(70,217,160,.14);border-radius:4px;padding:2px 6px;flex:none;")}>TEAM</span>)}
                              {card.favorite && (<span title="Favorite" style={css("font-size:12px;color:#ffcf5c;flex:none;")}>★</span>)}
                              <span style={css("font-size:10px;color:#6a6a74;border:1px solid #20202a;border-radius:5px;padding:2px 6px;flex:none;")}>{card.authIcon} {card.authLabel}</span>
                            </div>
                            <div className="aca-actions" style={css("position:absolute;top:11px;right:13px;display:flex;align-items:center;gap:5px;background:#0d0d11;padding-left:10px;")}>
                              <Hov onClick={card.onToggleFav} title={card.favorite ? 'Unfavorite' : 'Favorite'} s={{ width: '25px', height: '25px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: card.favorite ? '#ffcf5c' : '#9a9aa3', border: '1px solid #20202a', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', background: '#101015' }} h="background:#16161c;border-color:#2c2c36;">{card.favorite ? '★' : '☆'}</Hov>
                              <Hov onClick={card.onCopy} title="Copy ssh command" s="width:25px;height:25px;display:flex;align-items:center;justify-content:center;color:#9a9aa3;border:1px solid #20202a;border-radius:6px;font-size:11px;background:#101015;" h="background:#16161c;color:#ededf0;border-color:#2c2c36;">⧉</Hov>
                              <Hov onClick={card.onExport} title="Export connection" s="width:25px;height:25px;display:flex;align-items:center;justify-content:center;color:#9a9aa3;border:1px solid #20202a;border-radius:6px;font-size:12px;background:#101015;" h="background:#16161c;color:#ededf0;border-color:#2c2c36;">⤓</Hov>
                              {card.isLocal && (<Hov onClick={card.onSaveVault} title="Save to cloud vault (sync across your devices)" s="width:25px;height:25px;display:flex;align-items:center;justify-content:center;color:#9a9aa3;border:1px solid #20202a;border-radius:6px;font-size:12px;background:#101015;" h="background:rgba(70,217,160,.14);color:#46d9a0;border-color:rgba(70,217,160,.4);">☁</Hov>)}
                              <Hov onClick={card.onEdit} title="Edit connection" s="width:25px;height:25px;display:flex;align-items:center;justify-content:center;color:#9a9aa3;border:1px solid #20202a;border-radius:6px;font-size:11px;background:#101015;" h="background:#16161c;color:#ededf0;border-color:#2c2c36;">✎</Hov>
                            </div>
                            <div style={css("font-size:11.5px;color:#9a9aa3;font-family:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{card.target}<span style={css("color:#54545e;")}>:{card.port}</span></div>
                            {card.tags.length > 0 && (
                            <div style={css("display:flex;flex-wrap:wrap;gap:5px;")}>
                              {card.tags.map((t, ti) => (
                                <span key={ti} style={css("font-size:10px;color:#8b8b95;background:#15151b;border-radius:5px;padding:2px 7px;")}>#{t.name}</span>
                              ))}
                            </div>
                            )}
                            {card.presence.length > 0 && (
                              <Hov onClick={card.onPresence} title="See who’s online — and watch their session" s="display:flex;align-items:center;gap:8px;margin-top:3px;padding:7px 11px;background:rgba(70,217,160,.1);border:1px solid rgba(70,217,160,.28);border-radius:8px;cursor:pointer;" h="background:rgba(70,217,160,.18);border-color:rgba(70,217,160,.5);">
                                <span className="aca-livedot"></span>
                                <span style={css("font-size:11px;font-weight:600;color:#46d9a0;")}>{card.presence.length === 1 ? '1 teammate online' : card.presence.length + ' teammates online'}</span>
                                <span style={css("flex:1;")}></span>
                                <span style={css("font-size:10px;font-weight:600;color:#46d9a0;opacity:.85;")}>view →</span>
                              </Hov>
                            )}
                            <div style={css("display:flex;align-items:center;gap:6px;margin-top:3px;")}>
                              <span style={css("font-size:10px;color:#54545e;")}>last used {card.lastUsed}</span>
                              <span style={css("flex:1;")}></span>
                              <span style={css("font-size:10.5px;color:#ff7a59;font-weight:600;")}>Connect →</span>
                            </div>
                          </Hov>
                        ))}
                      </div>
                    </div>
                  ))}
                  {v.dashEmpty && (
                    <div style={css("display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:70px 20px;text-align:center;")}>
                      <span style={css("width:46px;height:46px;border:1.5px dashed #2a2a33;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#3a3a44;font-size:20px;")}>⌕</span>
                      <div style={css("font-size:13px;color:#9a9aa3;")}>No connections match your filters</div>
                      <div onClick={v.clearSearch} style={css("font-size:11.5px;color:#ff7a59;cursor:pointer;")}>Clear search</div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* TERMINAL WORKSPACE */}
            {v.isWorkspace && (
              <div style={css("flex:1;min-height:0;display:flex;flex-direction:column;")}>

                {/* TAB BAR */}
                <div style={css("height:42px;flex:none;display:flex;align-items:center;gap:4px;padding:0 8px;background:#0b0b0e;border-bottom:1px solid #16161c;")}>
                  <Hov onClick={v.toggleSidebar} title="Toggle sidebar (⌘B)" s="width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:5px;color:#6a6a74;cursor:pointer;flex:none;" h="background:#15151b;color:#ededf0;">▤</Hov>
                  <div style={css("display:flex;align-items:center;gap:4px;overflow:hidden;")}>
                    {v.tabs.map((tab) => (
                      <div key={tab.id} onClick={tab.onSelect} style={tab.style}>
                        <span style={tab.dotStyle}></span>
                        <span style={css("overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{tab.title}</span>
                        <Hov onClick={tab.onClose} s="margin-left:2px;width:16px;height:16px;display:flex;align-items:center;justify-content:center;border-radius:4px;color:#54545e;font-size:13px;" h="background:#26262e;color:#ededf0;">×</Hov>
                      </div>
                    ))}
                  </div>
                  <Hov onClick={v.newTab} title="New tab" s="width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:5px;color:#8b8b95;cursor:pointer;flex:none;font-size:15px;" h="background:#15151b;color:#ededf0;">+</Hov>
                  <span style={css("flex:1;")}></span>
                  <div style={css("display:flex;align-items:center;gap:3px;")}>
                    <Hov onClick={v.splitRight} title="Split right (⌘D)" s="width:28px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:5px;color:#8b8b95;cursor:pointer;" h="background:#15151b;color:#ededf0;"><span style={css("display:flex;gap:2px;")}><span style={css("width:5px;height:13px;border:1px solid currentColor;border-radius:2px;")}></span><span style={css("width:5px;height:13px;border:1px solid currentColor;border-radius:2px;")}></span></span></Hov>
                    <Hov onClick={v.splitDown} title="Split down" s="width:28px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:5px;color:#8b8b95;cursor:pointer;" h="background:#15151b;color:#ededf0;"><span style={css("display:flex;flex-direction:column;gap:2px;")}><span style={css("width:13px;height:5px;border:1px solid currentColor;border-radius:2px;")}></span><span style={css("width:13px;height:5px;border:1px solid currentColor;border-radius:2px;")}></span></span></Hov>
                  </div>
                </div>

                {/* WORKSPACE */}
                <div style={css("flex:1;min-height:0;display:flex;padding:10px;position:relative;")}>
                  {v.tabPanes.map((tp) => (
                  <div key={tp.id} ref={tp.active ? v.paneWrapRef : null} style={tp.wrapStyle}>
                    {tp.panes.map((pane) => (
                      <React.Fragment key={pane.id}>
                      {pane.notFirst && (<div className="aca-resizer" onMouseDown={pane.onGutterDown} style={pane.resizerStyle}><span className="aca-rzbar" style={pane.resizerBar}></span></div>)}
                      <div onMouseDown={pane.onActivate} style={pane.boxStyle}>
                        <div style={pane.headStyle}>
                          <span style={css("width:7px;height:7px;border-radius:2px;transform:rotate(45deg);background:" + (pane.spectate ? "#a970ff" : pane.teamConn ? "#46d9a0" : "#ff7a59") + ";flex:none;")}></span>
                          <span style={css("font-size:11px;color:#9a9aa3;")}>{pane.spectate ? "◉ " + (pane.watchName || "viewing") : pane.hostLabel}</span>
                          {pane.teamConn && pane.teamMembers.length > 0 && (
                            <span title="Teammates live on this connection — click to watch" style={css("display:flex;align-items:center;gap:3px;margin-left:7px;")}>
                              {pane.teamMembers.slice(0, 5).map((mmb, mi) => (
                                <Hov key={mi} onClick={() => pane.onWatch(mmb)} title={mmb.sessionId ? ("Watch " + mmb.displayName + "’s session (opens a new tab)") : (mmb.displayName + " — session not shareable yet")} s={{ width: "20px", height: "20px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "8.5px", fontWeight: 700, cursor: mmb.sessionId ? "pointer" : "default", background: mmb.sessionId ? "rgba(70,217,160,.16)" : "#16161c", color: mmb.sessionId ? "#46d9a0" : "#6a6a74", border: "1px solid " + (mmb.sessionId ? "rgba(70,217,160,.4)" : "#26262e") }} h={mmb.sessionId ? "background:rgba(70,217,160,.28);transform:translateY(-1px);" : ""}>{(mmb.displayName || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</Hov>
                              ))}
                            </span>
                          )}
                          <span style={css("flex:1;")}></span>
                          <span style={css("font-size:10px;color:#54545e;letter-spacing:.05em;")}>{pane.cwd}</span>
                          <Hov onMouseDown={pane.onClose} s="width:18px;height:18px;display:flex;align-items:center;justify-content:center;color:#54545e;border-radius:4px;cursor:pointer;" h="background:#222;color:#ededf0;">×</Hov>
                        </div>
                        {pane.live ? (
                          <TermPane key={pane.id + ":t"} session={{ sessionId: pane.sessionId, host: pane.hostObj, secret: pane.secret, keyText: pane.keyText, jump: pane.jump, kind: pane.kind, wsUrl: pane.wsUrl, watchName: pane.watchName }} theme={pane.termTheme} fontSize={pane.fontSize} cursor={pane.cursor} scrollback={pane.scrollback} onConnected={pane.onConnected} onError={pane.onError} onClosed={pane.onClosed} onHostKey={pane.onHostKey} register={this.registerTerm} isBroadcast={this.isBroadcast} onBroadcast={this.broadcastInput} onCwd={pane.onCwd} getTriggers={this.getTriggers} onTrigger={pane.onTrigger} suggest={this.suggestFor} recordCmd={this.recordCmd} suggestCfg={this.suggestCfg} seedHistory={this.seedHistory} />
                        ) : (
                        <div style={pane.termStyle}>
                          {pane.lines.map((line, li) => (
                            <div key={li} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: line.color }}>{line.display}</div>
                          ))}
                          <div style={css("display:flex;align-items:center;white-space:pre;margin-top:3px;")}>
                            <span style={{ color: pane.promptColor, fontWeight: 600 }}>{pane.promptUser}</span><span style={css("color:#6a6a74;")}>:</span><span style={css("color:#9a9aa3;")}>{pane.cwd}</span><span style={{ color: pane.promptColor, fontWeight: 600 }}>{"$ "}</span>
                            <input value={pane.input} onChange={pane.onInput} onKeyDown={pane.onKey} onFocus={pane.onActivate} ref={pane.setRef} spellCheck={false} autoComplete="off" style={css("flex:1;min-width:0;background:transparent;border:none;outline:none;color:inherit;caret-color:inherit;font:inherit;padding:0;")} />
                          </div>
                        </div>
                        )}
                      </div>
                      </React.Fragment>
                    ))}
                  </div>
                  ))}

                  {/* Drag divider — resize the terminal↔SFTP split (hidden when expanded) */}
                  {v.sftpOpen && !v.sftpMax && (
                    <div className="aca-resizer" onMouseDown={v.onSftpGutterDown} title="Drag to resize" style={css("width:8px;flex:none;margin-left:4px;display:flex;align-items:center;justify-content:center;cursor:col-resize;")}>
                      <span className="aca-rzbar" style={css("width:2px;height:42px;")}></span>
                    </div>
                  )}

                  {/* SFTP PANEL */}
                  {v.sftpOpen && (
                    <div style={css(`${v.sftpMax ? 'position:absolute;top:10px;right:10px;bottom:10px;left:10px;margin:0;z-index:6' : `width:${v.sftpW}px;flex:none;margin-left:6px`};background:#0b0b0e;border:1px solid #1c1c24;border-radius:9px;display:flex;flex-direction:column;overflow:hidden;animation:acaRise .2s ease;`)}>
                      <div style={css("display:flex;align-items:center;gap:9px;padding:11px 13px;border-bottom:1px solid #16161c;")}>
                        <span style={css("color:#ff7a59;")}>⇅</span>
                        <span style={css("font-size:12px;font-weight:600;color:#ededf0;")}>SFTP</span>
                        <span style={css("font-size:10px;color:#54545e;")}>·&nbsp;drag files between panes</span>
                        <span style={css("flex:1;")}></span>
                        <Hov onClick={v.toggleSftpMax} title={v.sftpMax ? 'Restore split view' : 'Expand SFTP to full screen'} s="width:18px;height:18px;display:flex;align-items:center;justify-content:center;color:#54545e;border-radius:4px;cursor:pointer;font-size:12px;" h="background:#222;color:#ededf0;">{v.sftpMax ? '⤡' : '⤢'}</Hov>
                        <Hov onClick={v.toggleSftp} s="width:18px;height:18px;display:flex;align-items:center;justify-content:center;color:#54545e;border-radius:4px;cursor:pointer;" h="background:#222;color:#ededf0;">×</Hov>
                      </div>
                      {v.sftpReady ? (
                      <div style={css("flex:1;min-height:0;display:flex;gap:9px;padding:11px;")}>
                        <div onDragOver={v.onDragOver} onDrop={v.onDropLocal} onDragEnter={v.onDragEnterLocal} onDragLeave={v.onDragLeave} style={v.localColStyle}>
                          <div style={css("padding:8px 10px;border-bottom:1px solid #16161c;")}>
                            <div style={css("font-size:9px;letter-spacing:.12em;color:#54545e;text-transform:uppercase;")}>Local</div>
                            <div style={css("font-size:10.5px;color:#9a9aa3;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{v.localPath}</div>
                          </div>
                          <div style={css("flex:1;overflow:auto;padding:5px;")}>
                            {v.localFiles.map((file, i) => (
                              <Hov key={i} draggable={!file.isUp} onDragStart={file.onDragStart} onClick={file.onClick} onDoubleClick={file.onDouble || undefined} onContextMenu={file.onContext} s={file.rowStyle} h="background:#15151b;">
                                <span style={{ color: file.glyphColor, width: "11px", textAlign: "center", flex: "none" }}>{file.glyph}</span>
                                <span style={css("flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{file.name}</span>
                                <span style={css("color:#54545e;font-size:10px;")}>{file.sub}</span>
                              </Hov>
                            ))}
                          </div>
                        </div>
                        <div onDragOver={v.onDragOver} onDrop={v.onDropRemote} onDragEnter={v.onDragEnterRemote} onDragLeave={v.onDragLeave} style={v.remoteColStyle}>
                          <div style={css("padding:8px 10px;border-bottom:1px solid #16161c;")}>
                            <div style={css("display:flex;align-items:center;gap:6px;")}>
                              <div style={css("flex:1;font-size:9px;letter-spacing:.12em;color:#ff7a59;text-transform:uppercase;")}>Remote · {v.sftpHost}</div>
                              <Hov onClick={v.sftpMkdir} title="New folder" s="width:18px;height:18px;display:flex;align-items:center;justify-content:center;color:#8b8b95;border-radius:4px;cursor:pointer;font-size:13px;" h="background:#222;color:#ededf0;">+</Hov>
                              <Hov onClick={v.sftpRename} title="Rename selected" s="width:18px;height:18px;display:flex;align-items:center;justify-content:center;color:#8b8b95;border-radius:4px;cursor:pointer;font-size:11px;" h="background:#222;color:#ededf0;">✎</Hov>
                              <Hov onClick={v.sftpDelete} title="Delete selected" s="width:18px;height:18px;display:flex;align-items:center;justify-content:center;color:#8b8b95;border-radius:4px;cursor:pointer;font-size:12px;" h="background:rgba(255,107,120,.15);color:#ff6b78;">🗑</Hov>
                            </div>
                            <div style={css("font-size:10.5px;color:#9a9aa3;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{v.remotePath}</div>
                          </div>
                          <div style={css("flex:1;overflow:auto;padding:5px;")}>
                            {v.remoteFiles.map((file, i) => (
                              <Hov key={i} draggable={!file.isUp} onDragStart={file.onDragStart} onClick={file.onClick} onDoubleClick={file.onDouble || undefined} onContextMenu={file.onContext} s={file.rowStyle} h="background:#15151b;">
                                <span style={{ color: file.glyphColor, width: "11px", textAlign: "center", flex: "none" }}>{file.glyph}</span>
                                <span style={css("flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{file.name}</span>
                                <span style={css("color:#54545e;font-size:10px;")}>{file.sub}</span>
                              </Hov>
                            ))}
                          </div>
                        </div>
                      </div>
                      ) : (
                        <div style={css("flex:1;min-height:0;display:flex;align-items:center;justify-content:center;text-align:center;font-size:11.5px;color:#6a6a74;padding:20px;")}>{v.sftpMsg}</div>
                      )}
                      {v.transferActive && (
                        <div style={css("padding:11px 13px;border-top:1px solid #16161c;")}>
                          <div style={css("display:flex;align-items:center;margin-bottom:7px;")}>
                            <span style={css("color:#ff7a59;margin-right:7px;")}>{v.transfer.arrow}</span>
                            <span style={css("font-size:11px;color:#cfcfd6;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{v.transfer.name}{v.transfer.queued > 0 ? ` · +${v.transfer.queued} queued` : ''}</span>
                            <span style={css("font-size:11px;color:#9a9aa3;")}>{v.transfer.pctLabel}</span>
                          </div>
                          <div style={css("height:4px;background:#16161c;border-radius:4px;overflow:hidden;")}>
                            <div style={v.transfer.fillStyle}></div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* STATUS BAR */}
            <div style={css("height:26px;flex:none;display:flex;align-items:center;gap:14px;padding:0 13px;background:#0a0a0d;border-top:1px solid #16161c;font-size:10.5px;color:#6a6a74;")}>
              <span style={css("display:flex;align-items:center;gap:6px;color:#9a9aa3;")}><span style={css("width:6px;height:6px;border-radius:2px;transform:rotate(45deg);background:#ff7a59;")}></span>main</span>
              <span>theme · {v.statusTheme}</span>
              <span>{v.statusHost}</span>
              {v.forwardCount > 0 && (<span style={css("color:#46d9a0;")}>⇄ {v.forwardCount} fwd</span>)}
              {v.broadcast && (<span onClick={v.toggleBroadcast} title="Broadcast input is on — click to turn off" style={css("color:#0c0b0a;background:#ff7a59;border-radius:4px;padding:1px 6px;cursor:pointer;font-weight:600;")}>⇉ broadcast</span>)}
              <span style={css("flex:1;")}></span>
              <span onClick={v.toggleTabSuggest} title={v.statusSuggestOn ? "Command autocomplete is on for this tab — click to turn off" : "Command autocomplete is off for this tab — click to turn on"} style={css(v.statusSuggestOn ? "color:#0c0b0a;background:#ff7a59;border-radius:4px;padding:1px 7px;cursor:pointer;font-weight:600;" : "color:#6a6a74;border:1px solid #26262e;border-radius:4px;padding:1px 6px;cursor:pointer;")}>⌁ autocomplete</span>
              <span>UTF-8</span>
              <span>LF</span>
              <span style={css("color:#46d9a0;")}>● ready</span>
            </div>
          </div>
        </div>

        {/* COMMAND PALETTE */}
        {v.paletteOpen && (
          <div onClick={v.closePalette} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:flex-start;justify-content:center;padding-top:92px;z-index:60;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:580px;max-width:90%;background:#0e0e13;border:1px solid #26262e;border-radius:13px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .16s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("display:flex;align-items:center;gap:11px;padding:14px 16px;border-bottom:1px solid #18181f;")}>
                <span style={css("color:#ff7a59;")}>›</span>
                <input value={v.paletteQuery} onChange={v.setPaletteQuery} ref={v.paletteRef} placeholder="Search commands, hosts, themes…" spellCheck={false} style={css("flex:1;background:transparent;border:none;outline:none;color:#ededf0;font:inherit;font-size:14px;")} />
                <span style={css("font-size:10px;color:#54545e;border:1px solid #26262e;border-radius:4px;padding:1px 6px;")}>esc</span>
              </div>
              <div style={css("max-height:320px;overflow:auto;")}>
                {v.paletteItems.map((it, i) => (
                  <Hov key={i} onClick={it.onRun} s="display:flex;align-items:center;gap:11px;padding:11px 16px;cursor:pointer;" h="background:#16161c;">
                    <span style={{ color: it.iconColor, width: "14px", textAlign: "center" }}>{it.icon}</span>
                    <span style={css("flex:1;font-size:12.5px;color:#dcdce2;")}>{it.name}</span>
                    <span style={css("font-size:10.5px;color:#54545e;")}>{it.hint}</span>
                  </Hov>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* THEMES BROWSER */}
        {v.themesOpen && (
          <div onClick={v.closeThemes} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:40px;z-index:60;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:760px;max-width:96%;max-height:88vh;display:flex;flex-direction:column;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("display:flex;align-items:center;gap:11px;padding:18px 22px;border-bottom:1px solid #18181f;")}>
                <div>
                  <div style={css("font-size:15px;font-weight:700;color:#f2f2f5;")}>Community Themes</div>
                  <div style={css("font-size:11px;color:#6a6a74;margin-top:2px;")}>{v.themesCount} themes · installed locally · click to apply instantly</div>
                </div>
                <span style={css("flex:1;")}></span>
                <Hov onClick={v.closeThemes} s="width:26px;height:26px;display:flex;align-items:center;justify-content:center;color:#8b8b95;border:1px solid #26262e;border-radius:6px;cursor:pointer;" h="background:#16161c;color:#ededf0;">×</Hov>
              </div>
              <div style={css("flex:1;overflow:auto;padding:18px 22px;display:grid;grid-template-columns:repeat(3,1fr);gap:14px;")}>
                {v.themesList.map((th) => (
                  <div key={th.id} onClick={th.onApply} style={th.cardStyle}>
                    <div style={{ height: "62px", borderRadius: "7px", background: th.bg, padding: "9px", display: "flex", flexDirection: "column", gap: "5px", justifyContent: "center" }}>
                      <div style={{ height: "5px", width: "58%", borderRadius: "3px", background: th.accent }}></div>
                      <div style={{ height: "5px", width: "82%", borderRadius: "3px", background: th.fg, opacity: 0.72 }}></div>
                      <div style={{ height: "5px", width: "44%", borderRadius: "3px", background: th.fg, opacity: 0.4 }}></div>
                    </div>
                    <div style={css("display:flex;align-items:center;margin-top:11px;")}>
                      <span style={css("font-size:12.5px;font-weight:600;color:#ededf0;flex:1;")}>{th.name}</span>
                      {th.active && (<span style={css("font-size:9px;letter-spacing:.1em;color:#ff7a59;border:1px solid rgba(255,122,89,.35);border-radius:4px;padding:1px 6px;")}>ACTIVE</span>)}
                    </div>
                    <div style={css("font-size:10.5px;color:#6a6a74;margin-top:3px;")}>by {th.author}</div>
                    <div style={css("display:flex;gap:4px;margin-top:10px;")}>
                      {th.sw.map((sw, si) => (
                        <span key={si} style={{ width: "16px", height: "16px", borderRadius: "4px", background: sw, border: "1px solid rgba(255,255,255,.06)" }}></span>
                      ))}
                      <span style={css("flex:1;")}></span>
                      <span style={css("font-size:10px;color:#54545e;align-self:center;")}>↓ {th.downloads}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ABOUT / AUTHOR */}
        {/* SFTP RIGHT-CLICK MENU */}
        {v.sftpCtx && (
          <>
            <div onClick={v.closeFileCtx} onContextMenu={(e) => { e.preventDefault(); v.closeFileCtx(); }} style={css("position:fixed;inset:0;z-index:80;")}></div>
            <div style={{ position: 'fixed', left: v.sftpCtx.x + 'px', top: v.sftpCtx.y + 'px', zIndex: 81, minWidth: '186px', maxWidth: '240px', background: '#101015', border: '1px solid #26262e', borderRadius: '9px', padding: '5px', boxShadow: '0 18px 44px rgba(0,0,0,.6)', fontSize: '12px', animation: 'acaFade .1s ease' }}>
              <Hov onClick={() => v.ctxOpen(v.sftpCtx.side, v.sftpCtx.name, v.sftpCtx.isDir)} s="display:block;padding:7px 10px;border-radius:6px;cursor:pointer;color:#cfcfd6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" h="background:#1a1a22;color:#ededf0;">{v.sftpCtx.isDir ? 'Open folder' : (v.sftpCtx.side === 'remote' ? 'Download & open' : 'Open with default app')}</Hov>
              {v.sftpCtx.side === 'local' && !v.sftpCtx.isDir && (
                <Hov onClick={v.ctxReveal} s="display:block;padding:7px 10px;border-radius:6px;cursor:pointer;color:#cfcfd6;" h="background:#1a1a22;color:#ededf0;">Reveal in file manager</Hov>
              )}
              {v.sftpCtx.side === 'remote' && (
                <>
                  <div style={css("height:1px;background:#1e1e26;margin:4px 6px;")}></div>
                  <Hov onClick={() => { v.closeFileCtx(); v.sftpRename(); }} s="display:block;padding:7px 10px;border-radius:6px;cursor:pointer;color:#cfcfd6;" h="background:#1a1a22;color:#ededf0;">Rename…</Hov>
                  <Hov onClick={() => { v.closeFileCtx(); v.sftpDelete(); }} s="display:block;padding:7px 10px;border-radius:6px;cursor:pointer;color:#ff6b78;" h="background:rgba(255,107,120,.14);color:#ff6b78;">Delete</Hov>
                </>
              )}
            </div>
          </>
        )}

        {v.aboutOpen && (
          <div onClick={v.closeAbout} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:40px;z-index:66;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:420px;max-width:96%;display:flex;flex-direction:column;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("display:flex;align-items:center;gap:11px;padding:16px 20px;border-bottom:1px solid #18181f;")}>
                <span style={css("font-size:13px;font-weight:700;color:#f2f2f5;")}>About</span>
                <span style={css("flex:1;")}></span>
                <Hov onClick={v.closeAbout} s="width:26px;height:26px;display:flex;align-items:center;justify-content:center;color:#8b8b95;border:1px solid #26262e;border-radius:6px;cursor:pointer;" h="background:#16161c;color:#ededf0;">×</Hov>
              </div>
              <div style={css("padding:26px 22px 24px;display:flex;flex-direction:column;align-items:center;text-align:center;")}>
                <img src={logoMark} width="80" height="80" alt="SSH Ache" style={{ borderRadius: "22px", boxShadow: "0 0 32px rgba(255,77,112,.42)" }} />
                <div style={css("font-size:17px;font-weight:700;color:#f2f2f5;margin-top:15px;")}>{v.author.name}</div>
                <div style={css("font-size:11.5px;color:#6a6a74;margin-top:3px;")}>Author &amp; developer of SSH&nbsp;Ache</div>
                <div style={css("position:relative;margin-top:18px;padding:15px 18px 14px;background:#0e0e12;border:1px solid #1c1c24;border-radius:12px;")}>
                  <span style={css("position:absolute;top:-12px;left:12px;font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:1;color:#ff5f6d;opacity:.55;")}>&ldquo;</span>
                  <div style={{ ...css("font-size:13px;font-style:italic;line-height:1.62;font-weight:600;"), background: "linear-gradient(120deg,#ff8a63,#ff5f6d,#ff3d7f)", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent" }}>{v.author.motto}</div>
                </div>
                <div style={css("display:flex;gap:8px;margin-top:20px;width:100%;")}>
                  <Hov as="button" onClick={() => v.openExt(v.author.github)} s="flex:1;padding:9px 8px;background:#101015;border:1px solid #20202a;border-radius:7px;color:#b9b9c2;font:inherit;font-size:11px;cursor:pointer;" h="background:#16161c;color:#ededf0;">GitHub</Hov>
                  <Hov as="button" onClick={() => v.openExt('mailto:' + v.author.email)} s="flex:1;padding:9px 8px;background:#101015;border:1px solid #20202a;border-radius:7px;color:#b9b9c2;font:inherit;font-size:11px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Email</Hov>
                  <Hov as="button" onClick={() => v.openExt(v.author.site)} s="flex:1;padding:9px 8px;background:#101015;border:1px solid #20202a;border-radius:7px;color:#b9b9c2;font:inherit;font-size:11px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Website</Hov>
                </div>
                <Hov as="button" onClick={() => v.openExt(v.author.tip)} s="margin-top:11px;width:100%;padding:11px;background:linear-gradient(135deg,#ff7a59,#ff4f7a);border:none;border-radius:8px;color:#0c0b0a;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;" h="filter:brightness(1.06);">☕&nbsp;Buy me a coffee</Hov>
                <Hov as="button" onClick={v.openWhatsNew} s="margin-top:12px;background:none;border:none;color:#7a7a85;font:inherit;font-size:11px;text-decoration:underline;cursor:pointer;" h="color:#ededf0;">What's new in SSH&nbsp;Ache</Hov>
                <div style={css("font-size:10px;color:#54545e;margin-top:10px;")}>SSH&nbsp;Ache · v{v.appVersion}</div>
              </div>
            </div>
          </div>
        )}

        {/* WHO'S ONLINE (team connection) — view any active teammate's session */}
        {this.state.presenceModal && (
          <div onClick={() => this.setState({ presenceModal: null })} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:40px;z-index:67;animation:acaFade .12s ease;")}>
            <div onClick={(e) => e.stopPropagation()} style={css("width:400px;max-width:96%;display:flex;flex-direction:column;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("display:flex;align-items:center;gap:9px;padding:16px 20px;border-bottom:1px solid #18181f;")}>
                <span className="aca-livedot"></span>
                <span style={css("font-size:13px;font-weight:700;color:#f2f2f5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>Online · {this.state.presenceModal.name}</span>
                <span style={css("flex:1;")}></span>
                <Hov onClick={() => this.setState({ presenceModal: null })} s="width:26px;height:26px;display:flex;align-items:center;justify-content:center;color:#8b8b95;border:1px solid #26262e;border-radius:6px;cursor:pointer;" h="background:#16161c;color:#ededf0;">×</Hov>
              </div>
              <div style={css("padding:10px;display:flex;flex-direction:column;gap:6px;max-height:60vh;overflow:auto;")}>
                {this.state.presenceModal.presence.length === 0 && (
                  <div style={css("padding:22px;text-align:center;color:#6a6a74;font-size:12px;")}>No one else is on this connection right now.</div>
                )}
                {this.state.presenceModal.presence.map((mmb, mi) => (
                  <div key={mi} style={css("display:flex;align-items:center;gap:11px;padding:10px 12px;background:#0e0e13;border:1px solid #1c1c24;border-radius:10px;")}>
                    <span style={css("width:32px;height:32px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#46d9a0;background:rgba(70,217,160,.14);border:1px solid rgba(70,217,160,.3);")}>{(mmb.displayName || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span>
                    <div style={css("flex:1;min-width:0;")}>
                      <div style={css("font-size:13px;font-weight:600;color:#ededf0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{mmb.displayName}</div>
                      <div style={css("font-size:11px;color:#6a6a74;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{mmb.email || (mmb.kind === "native" ? "desktop app" : "web terminal")}</div>
                    </div>
                    {mmb.sessionId ? (
                      <Hov as="button" onClick={() => this.openSpectate(this.state.presenceModal.teamId, mmb.sessionId, mmb.displayName)} s="flex:none;padding:7px 13px;background:rgba(70,217,160,.14);border:1px solid rgba(70,217,160,.4);border-radius:7px;color:#46d9a0;font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;" h="background:rgba(70,217,160,.26);">◉ View</Hov>
                    ) : (
                      <span title="This session isn’t shareable yet (they need to reconnect on a build with mirroring)" style={css("flex:none;font-size:10px;color:#54545e;")}>—</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* WHAT'S NEW */}
        {this.state.keysOpen && (
          <KeyVaultModal
            keys={this.state.vaultKeys}
            onAdd={(n: string, k: string, p: string) => this.addVaultKey(n, k, p)}
            onDelete={(id: string) => this.deleteVaultKey(id)}
            onReveal={(id: string) => this.revealVaultKey(id)}
            onClose={() => this.setState({ keysOpen: false })}
          />
        )}
        {v.whatsNewOpen && (
          <div onClick={v.closeWhatsNew} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:40px;z-index:66;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:470px;max-width:96%;max-height:80vh;display:flex;flex-direction:column;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("display:flex;align-items:center;gap:11px;padding:16px 20px;border-bottom:1px solid #18181f;")}>
                <span style={css("color:#46d9a0;")}>✦</span>
                <span style={css("font-size:13px;font-weight:700;color:#f2f2f5;")}>What's new</span>
                <span style={css("flex:1;")}></span>
                <Hov onClick={v.closeWhatsNew} s="width:26px;height:26px;display:flex;align-items:center;justify-content:center;color:#8b8b95;border:1px solid #26262e;border-radius:6px;cursor:pointer;" h="background:#16161c;color:#ededf0;">×</Hov>
              </div>
              <div style={css("padding:18px 22px 22px;overflow:auto;")}>
                {v.changelog.map((rel, ri) => (
                  <div key={ri} style={css("margin-bottom:17px;")}>
                    <div style={css("display:flex;align-items:center;gap:8px;margin-bottom:6px;")}>
                      <span style={css("font-size:12.5px;font-weight:700;color:#ededf0;")}>v{rel.version}</span>
                      {ri === 0 && (<span style={css("font-size:8.5px;letter-spacing:.08em;color:#0c0b0a;background:#46d9a0;border-radius:4px;padding:1px 6px;")}>LATEST</span>)}
                    </div>
                    {rel.items.map((it, ii) => (
                      <div key={ii} style={css("display:flex;gap:8px;font-size:11.5px;color:#b9b9c2;line-height:1.55;margin-top:5px;")}>
                        <span style={css("color:#ff7a59;flex:none;")}>›</span><span>{it}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* FIRST-RUN TOUR */}
        {!v.tourSeen && (() => {
          const step = TOUR_STEPS[Math.min(v.tourStep, TOUR_STEPS.length - 1)];
          const last = v.tourStep >= TOUR_STEPS.length - 1;
          return (
            <div style={css("position:absolute;inset:0;background:rgba(5,5,7,.74);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:32px;z-index:90;animation:acaFade .15s ease;")}>
              <div style={css("position:relative;width:444px;max-width:96%;background:#0c0c10;border:1px solid #26262e;border-radius:16px;box-shadow:0 40px 100px rgba(0,0,0,.7);padding:30px 28px 24px;text-align:center;animation:acaModal .2s cubic-bezier(.2,.8,.2,1);")}>
                <div onClick={v.tourDone} style={css("position:absolute;top:14px;right:16px;font-size:11px;color:#6a6a74;cursor:pointer;")}>Skip ✕</div>
                <div style={{ ...css("width:64px;height:64px;margin:0 auto;border-radius:18px;display:flex;align-items:center;justify-content:center;font-size:23px;font-weight:700;color:#0c0b0a;"), background: 'linear-gradient(135deg,var(--accent-hi),var(--accent))', boxShadow: '0 0 30px rgba(var(--accent-rgb),.45)' }}>{step.icon}</div>
                <div style={css("font-size:18px;font-weight:700;color:#f2f2f5;margin-top:18px;")}>{step.title}</div>
                <div style={css("font-size:12.5px;color:#9a9aa3;margin-top:9px;line-height:1.62;")}>{step.body}</div>
                <div style={css("display:flex;align-items:center;justify-content:center;gap:6px;margin-top:20px;")}>
                  {TOUR_STEPS.map((_, i) => (<span key={i} style={{ width: i === v.tourStep ? '18px' : '6px', height: '6px', borderRadius: '3px', background: i === v.tourStep ? 'var(--accent)' : 'var(--border2)', transition: 'all .2s ease' }}></span>))}
                </div>
                <div style={css("display:flex;gap:10px;margin-top:22px;")}>
                  {v.tourStep > 0 && (<Hov as="button" onClick={v.tourBack} s="flex:1;padding:10px;background:#101015;border:1px solid #20202a;border-radius:9px;color:#b9b9c2;font:inherit;font-size:12px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Back</Hov>)}
                  <Hov as="button" onClick={last ? v.tourDone : v.tourNext} s="flex:2;padding:10px;background:#ff7a59;border:none;border-radius:9px;color:#0c0b0a;font:inherit;font-size:12px;font-weight:700;cursor:pointer;" h="background:#ff8d70;">{last ? 'Get started' : 'Next'}</Hov>
                </div>
              </div>
            </div>
          );
        })()}

        {/* CONNECTION LOADER */}
        {v.connectingActive && (
          <div style={css("position:absolute;inset:0;background:rgba(5,5,7,.72);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:70;animation:acaFade .12s ease;")}>
            <div style={v.connectingCardStyle}>
              <div style={css("position:relative;width:88px;height:88px;margin:0 auto 18px;display:flex;align-items:center;justify-content:center;")}>
                <span style={v.connecting.ringStyle}></span>
                <span style={v.connecting.ring2Style}></span>
                <span style={v.connecting.spinnerStyle}></span>
                <span style={v.connecting.coreStyle}></span>
              </div>
              <div style={css("text-align:center;font-size:14px;font-weight:600;color:#f2f2f5;")}>{v.connecting.titleText}</div>
              <div style={css("text-align:center;font-size:11.5px;color:#6a6a74;margin-top:4px;")}>{v.connecting.target}</div>
              <div style={css("margin-top:18px;display:flex;flex-direction:column;gap:2px;")}>
                {v.connecting.steps.map((step, i) => (
                  <div key={i} style={css("display:flex;align-items:center;gap:11px;padding:5px 2px;")}>
                    {step.active && (<span style={css("width:14px;height:14px;border-radius:50%;border:2px solid #2a2a33;border-top-color:#ff7a59;animation:acaSpin .8s linear infinite;flex:none;")}></span>)}
                    {step.notActive && (<span style={{ width: "14px", height: "14px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", color: step.glyphColor, flex: "none" }}>{step.glyph}</span>)}
                    <span style={{ fontSize: "11.5px", color: step.labelColor }}>{step.label}</span>
                  </div>
                ))}
              </div>
              <Hov as="button" onClick={v.cancelConnect} s="margin-top:18px;width:100%;padding:8px;background:#121217;border:1px solid #26262e;border-radius:7px;color:#9a9aa3;font:inherit;font-size:11.5px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Cancel</Hov>
            </div>
          </div>
        )}

        {/* ADD HOST */}
        {v.addHostOpen && (
          <div onClick={v.closeAddHost} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:32px;z-index:65;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:560px;max-width:96%;max-height:90vh;display:flex;flex-direction:column;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("display:flex;align-items:center;gap:11px;padding:18px 22px;border-bottom:1px solid #18181f;")}>
                <span style={css("width:14px;height:14px;background:#ff7a59;border-radius:3px;transform:rotate(45deg);flex:none;")}></span>
                <div style={css("flex:1;")}>
                  <div style={css("font-size:15px;font-weight:700;color:#f2f2f5;")}>{v.modalTitle}</div>
                  <div style={css("font-size:11px;color:#6a6a74;margin-top:1px;")}>{v.modalSubtitle}</div>
                </div>
                <Hov onClick={v.closeAddHost} s="width:26px;height:26px;display:flex;align-items:center;justify-content:center;color:#8b8b95;border:1px solid #26262e;border-radius:6px;cursor:pointer;" h="background:#16161c;color:#ededf0;">×</Hov>
              </div>
              <div style={css("flex:1;overflow:auto;padding:20px 22px;display:flex;flex-direction:column;gap:16px;")}>
                <div>
                  <div style={css("font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:7px;")}>Label</div>
                  <Hov as="input" value={v.fName} onChange={v.onFName} placeholder="e.g. production-web" spellCheck={false} s="width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;" f="border-color:rgba(255,122,89,.5);" />
                </div>
                <div style={css("display:flex;gap:12px;")}>
                  <div style={css("flex:1;")}>
                    <div style={css("font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:7px;")}>Host / IP</div>
                    <Hov as="input" value={v.fHost} onChange={v.onFHost} placeholder="10.0.0.5 or example.com" spellCheck={false} s="width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;" f="border-color:rgba(255,122,89,.5);" />
                  </div>
                  <div style={css("width:92px;flex:none;")}>
                    <div style={css("font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:7px;")}>Port</div>
                    <Hov as="input" value={v.fPort} onChange={v.onFPort} placeholder="22" spellCheck={false} s="width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;" f="border-color:rgba(255,122,89,.5);" />
                  </div>
                </div>
                <div>
                  <div style={css("font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:7px;")}>Username</div>
                  <Hov as="input" value={v.fUser} onChange={v.onFUser} placeholder="root" spellCheck={false} s="width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;" f="border-color:rgba(255,122,89,.5);" />
                </div>
                <div>
                  <div style={css("font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:7px;")}>Authentication</div>
                  <div style={css("display:flex;gap:7px;")}>
                    <div onClick={v.setAuthPassword} style={v.authPwStyle}>Password</div>
                    <div onClick={v.setAuthKey} style={v.authKeyStyle}>Key file</div>
                    <div onClick={v.setAuthAgent} style={v.authAgentStyle}>SSH agent</div>
                  </div>
                  {v.authIsPassword && (
                    <Hov as="input" value={v.fPassword} onChange={v.onFPassword} type="password" placeholder="Password (stored encrypted)" s="width:100%;margin-top:10px;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;" f="border-color:rgba(255,122,89,.5);" />
                  )}
                  {v.authIsKey && (
                    <div style={css("margin-top:10px;display:flex;flex-direction:column;gap:9px;")}>
                      <div style={css("display:flex;gap:6px;padding:4px;background:#0e0e12;border:1px solid #20202a;border-radius:8px;")}>
                        <div onClick={v.setKeyModeFile} style={v.keyFileStyle}>File path</div>
                        <div onClick={v.setKeyModeText} style={v.keyTextStyle}>Paste text</div>
                        <div onClick={v.setKeyModeVault} style={v.keyVaultStyle}>Saved key</div>
                      </div>
                      {v.keyModeFile && (
                        <div style={css("display:flex;flex-direction:column;gap:9px;")}>
                          <div style={css("display:flex;gap:8px;")}>
                            <Hov as="input" value={v.fKeyPath} onChange={v.onFKeyPath} placeholder="~/.ssh/id_ed25519" spellCheck={false} s="flex:1;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;" f="border-color:rgba(255,122,89,.5);" />
                            <Hov as="button" onClick={v.onBrowseKey} s="flex:none;padding:0 14px;background:#101015;border:1px solid #20202a;border-radius:8px;color:#b9b9c2;font:inherit;font-size:12px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Browse…</Hov>
                          </div>
                          <Hov as="input" value={v.fPassphrase} onChange={v.onFPassphrase} type="password" placeholder="Key passphrase (optional)" s="width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;" f="border-color:rgba(255,122,89,.5);" />
                        </div>
                      )}
                      {v.keyModeText && (
                        <div style={css("display:flex;flex-direction:column;gap:0;")}>
                          <textarea value={v.fKeyText} onChange={v.onFKeyText} placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA…\n-----END OPENSSH PRIVATE KEY-----"} spellCheck={false} style={v.keyTextAreaStyle}></textarea>
                          {v.keyShowStatus && (
                            <div style={v.keyStatusStyle}>
                              <span style={v.keyIconStyle}>{v.keyStatusIcon}</span>
                              <span>{v.keyStatusMsg}</span>
                            </div>
                          )}
                          <Hov as="input" value={v.fPassphrase} onChange={v.onFPassphrase} type="password" placeholder="Key passphrase (optional)" s="width:100%;margin-top:9px;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;" f="border-color:rgba(255,122,89,.5);" />
                          <Hov as="input" value={v.fSaveKeyName} onChange={v.onFSaveKeyName} placeholder="Save to Key Vault as… (optional name)" spellCheck={false} s="width:100%;margin-top:9px;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:12.5px;outline:none;" f="border-color:rgba(70,217,160,.5);" />
                        </div>
                      )}
                      {v.keyModeVault && (
                        <div style={css("display:flex;flex-direction:column;gap:9px;")}>
                          {v.vaultKeyOptions.length === 0 ? (
                            <div style={css("font-size:11.5px;color:#6a6a74;padding:11px 13px;background:#0e0e12;border:1px solid #20202a;border-radius:8px;")}>No saved keys yet — paste a key and name it to save one.</div>
                          ) : (
                            <>
                              <select value={v.fVaultKeyId} onChange={v.onPickVaultKey} style={css("width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;")}>
                                <option value="">Choose a saved key…</option>
                                {v.vaultKeyOptions.map((k) => (<option key={k.id} value={k.id}>{k.label}</option>))}
                              </select>
                              <Hov as="input" value={v.fPassphrase} onChange={v.onFPassphrase} type="password" placeholder="Key passphrase (optional)" s="width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;" f="border-color:rgba(255,122,89,.5);" />
                            </>
                          )}
                          <div onClick={v.openKeys} style={css("font-size:11px;color:#46d9a0;cursor:pointer;")}>Manage saved keys →</div>
                        </div>
                      )}
                    </div>
                  )}
                  {v.authIsAgent && (
                    <div style={css("margin-top:10px;font-size:11.5px;color:#6a6a74;padding:11px 13px;background:#0e0e12;border:1px solid #20202a;border-radius:8px;")}>Uses your running ssh-agent identities. No secrets stored.</div>
                  )}
                </div>
                <div>
                  <div style={css("font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:7px;")}>Folder</div>
                  <Hov as="input" value={v.fFolder} onChange={v.onFFolder} placeholder="Production, Personal, …" spellCheck={false} s="width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;" f="border-color:rgba(255,122,89,.5);" />
                  <div style={css("display:flex;flex-wrap:wrap;gap:6px;margin-top:9px;")}>
                    {v.folderChips.map((fc, i) => (
                      <Hov key={i} onClick={fc.onPick} s="font-size:10.5px;color:#9a9aa3;background:#101015;border:1px solid #20202a;border-radius:6px;padding:4px 9px;cursor:pointer;" h="border-color:rgba(255,122,89,.4);color:#ededf0;">{fc.name}</Hov>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={css("font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:7px;")}>Jump host <span style={css("text-transform:none;letter-spacing:0;color:#54545e;")}>· optional, connect through a bastion</span></div>
                  <select value={v.fJumpHost} onChange={v.onFJumpHost} style={css("width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;")}>
                    <option value="">None — connect directly</option>
                    {v.jumpOptions.map((jo) => (<option key={jo.id} value={jo.id}>{jo.label}</option>))}
                  </select>
                </div>
                <div>
                  <div style={css("font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:7px;")}>On-connect command <span style={css("text-transform:none;letter-spacing:0;color:#54545e;")}>· optional, runs after the shell opens</span></div>
                  <Hov as="input" value={v.fSnippet} onChange={v.onFSnippet} placeholder="tmux attach || tmux new" spellCheck={false} s="width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;" f="border-color:rgba(255,122,89,.5);" />
                </div>
                <div>
                  <div style={css("font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:7px;")}>Tags</div>
                  <Hov as="input" value={v.fTagInput} onChange={v.onFTagInput} onKeyDown={v.onFTagKey} placeholder="Type a tag and press Enter" spellCheck={false} s="width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;" f="border-color:rgba(255,122,89,.5);" />
                  <div style={css("display:flex;flex-wrap:wrap;gap:6px;margin-top:9px;")}>
                    {v.fTags.map((tg, i) => (
                      <span key={i} style={css("display:flex;align-items:center;gap:6px;font-size:11px;color:#ff7a59;background:rgba(255,122,89,.1);border:1px solid rgba(255,122,89,.35);border-radius:6px;padding:4px 6px 4px 9px;")}>#{tg.name}<span onClick={tg.onRemove} style={css("cursor:pointer;color:#ff7a59;opacity:.7;font-size:13px;line-height:1;")}>×</span></span>
                    ))}
                  </div>
                </div>
              </div>
              <div style={css("flex:none;display:flex;align-items:center;gap:10px;padding:16px 22px;border-top:1px solid #18181f;")}>
                {v.isEditing && (
                  <Hov as="button" onClick={v.deleteHost} s="padding:10px 14px;background:transparent;border:1px solid rgba(255,107,120,.35);border-radius:8px;color:#ff6b78;font:inherit;font-size:12.5px;cursor:pointer;" h="background:rgba(255,107,120,.1);">Delete</Hov>
                )}
                <span style={css("font-size:10.5px;color:#54545e;")}>⚿ encrypted on disk</span>
                <span style={css("flex:1;")}></span>
                <Hov as="button" onClick={v.closeAddHost} s="padding:10px 16px;background:#101015;border:1px solid #20202a;border-radius:8px;color:#b9b9c2;font:inherit;font-size:12.5px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Cancel</Hov>
                <button onClick={v.saveHost} style={v.saveHostStyle}>{v.saveLabel}</button>
              </div>
            </div>
          </div>
        )}

        {/* SETTINGS */}
        {v.settingsOpen && (
          <div onClick={v.closeSettings} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:32px;z-index:65;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:600px;max-width:96%;max-height:90vh;display:flex;flex-direction:column;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("display:flex;align-items:center;gap:11px;padding:18px 22px;border-bottom:1px solid #18181f;")}>
                <div style={css("flex:1;")}>
                  <div style={css("font-size:15px;font-weight:700;color:#f2f2f5;")}>Settings</div>
                  <div style={css("font-size:11px;color:#6a6a74;margin-top:1px;")}>Preferences saved locally to ~/.ssh-ache/state.json</div>
                </div>
                <Hov onClick={v.closeSettings} s="width:26px;height:26px;display:flex;align-items:center;justify-content:center;color:#8b8b95;border:1px solid #26262e;border-radius:6px;cursor:pointer;" h="background:#16161c;color:#ededf0;">×</Hov>
              </div>
              <div style={css("flex:1;overflow:auto;padding:20px 22px;display:flex;flex-direction:column;gap:24px;")}>

                <div>
                  <div style={css("font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#ff7a59;margin-bottom:12px;")}>Appearance</div>
                  <div style={css("font-size:12px;color:#cfcfd6;margin-bottom:9px;")}>Default theme</div>
                  <div style={css("display:grid;grid-template-columns:repeat(4,1fr);gap:8px;")}>
                    {v.themeOptions.map((th) => (
                      <div key={th.id} onClick={th.onPick} style={th.style}>
                        <span style={th.dotStyle}></span>
                        <span style={css("overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{th.name}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div style={css("font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#ff7a59;margin-bottom:12px;")}>Terminal</div>
                  <div style={css("display:flex;align-items:center;gap:12px;margin-bottom:16px;")}>
                    <span style={css("flex:1;font-size:12px;color:#cfcfd6;")}>Font size</span>
                    <input type="range" min="11" max="18" step="1" value={v.fontSize} onChange={v.onFontSize} style={css("width:180px;accent-color:#ff7a59;")} />
                    <span style={css("font-size:11px;color:#9a9aa3;width:34px;text-align:right;")}>{v.fontSizeLabel}</span>
                  </div>
                  <div style={css("display:flex;align-items:center;gap:12px;margin-bottom:16px;")}>
                    <span style={css("flex:1;font-size:12px;color:#cfcfd6;")}>Cursor</span>
                    <div style={css("display:flex;gap:6px;width:280px;")}>
                      <div onClick={v.setCursorBlock} style={v.cursorBlockStyle}>Block</div>
                      <div onClick={v.setCursorBar} style={v.cursorBarStyle}>Bar</div>
                      <div onClick={v.setCursorUnder} style={v.cursorUnderStyle}>Underline</div>
                    </div>
                  </div>
                  <div style={css("display:flex;align-items:center;gap:12px;")}>
                    <span style={css("flex:1;font-size:12px;color:#cfcfd6;")}>Scrollback (lines)</span>
                    <Hov as="input" value={v.scrollback} onChange={v.onScrollback} s="width:120px;background:#0e0e12;border:1px solid #20202a;border-radius:7px;padding:8px 11px;color:#ededf0;font:inherit;font-size:12px;outline:none;" f="border-color:rgba(255,122,89,.5);" />
                  </div>
                </div>

                <div>
                  <div style={css("font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#ff7a59;margin-bottom:6px;")}>Output triggers</div>
                  <div style={css("font-size:10.5px;color:#54545e;margin-bottom:12px;line-height:1.5;")}>Watch terminal output for a regular expression. Matching lines get a coloured marker and/or a notification.</div>
                  {v.triggers.length > 0 && (
                    <div style={css("display:flex;flex-direction:column;gap:7px;margin-bottom:12px;")}>
                      {v.triggers.map((t) => (
                        <div key={t.id} style={css("display:flex;align-items:center;gap:9px;padding:8px 10px;background:#0e0e12;border:1px solid #1c1c24;border-radius:8px;")}>
                          <span style={{ width: '9px', height: '9px', borderRadius: '2px', background: t.color || '#ff7a59', flex: 'none' }}></span>
                          <code style={css("flex:1;font-size:11.5px;color:#ededf0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{t.pattern}</code>
                          <Hov onClick={() => v.toggleTriggerNotify(t.id)} title="Notification on match" s={"font-size:10px;padding:3px 8px;border-radius:5px;cursor:pointer;border:1px solid " + (t.notify !== false ? 'rgba(255,122,89,.5);color:#ff7a59;background:rgba(255,122,89,.1)' : '#26262e;color:#6a6a74;background:transparent') + ";"} h="border-color:rgba(255,122,89,.6);">🔔 Notify</Hov>
                          <Hov onClick={() => v.toggleTriggerHighlight(t.id)} title="Highlight the matching line" s={"font-size:10px;padding:3px 8px;border-radius:5px;cursor:pointer;border:1px solid " + (t.highlight !== false ? 'rgba(255,122,89,.5);color:#ff7a59;background:rgba(255,122,89,.1)' : '#26262e;color:#6a6a74;background:transparent') + ";"} h="border-color:rgba(255,122,89,.6);">▎Highlight</Hov>
                          <Hov onClick={() => v.removeTrigger(t.id)} title="Remove" s="width:22px;height:22px;display:flex;align-items:center;justify-content:center;color:#8b8b95;border-radius:5px;cursor:pointer;flex:none;" h="background:rgba(255,107,120,.15);color:#ff6b78;">×</Hov>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={css("display:flex;align-items:center;gap:8px;")}>
                    <Hov as="input" value={v.triggerDraft} onChange={v.onTriggerDraft} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); v.addTrigger(); } }} placeholder="Pattern, e.g.  error|fatal|panic" spellCheck={false} s="flex:1;background:#0e0e12;border:1px solid #20202a;border-radius:7px;padding:8px 11px;color:#ededf0;font:inherit;font-size:12px;outline:none;" f="border-color:rgba(255,122,89,.5);" />
                    <input type="color" value={v.triggerColor} onChange={v.onTriggerColor} title="Marker colour" style={css("width:30px;height:32px;background:#0e0e12;border:1px solid #20202a;border-radius:7px;padding:2px;cursor:pointer;")} />
                    <Hov as="button" onClick={v.addTrigger} s="padding:8px 14px;background:#ff7a59;border:none;border-radius:7px;color:#0c0b0a;font:inherit;font-size:12px;font-weight:600;cursor:pointer;flex:none;" h="background:#ff8d70;">Add</Hov>
                  </div>
                </div>

                <div>
                  <div style={css("font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#ff7a59;margin-bottom:6px;")}>Command autosuggest</div>
                  <div style={css("font-size:10.5px;color:#54545e;margin-bottom:12px;line-height:1.5;")}>As you type, the most recent matching command from your history shows as dim text — press Tab, →, or End to accept. Builds from commands you run (and the remote host's history on connect). Stays on this device.</div>
                  <div style={css("display:flex;align-items:center;gap:12px;")}>
                    <div style={css("flex:1;")}><div style={css("font-size:12px;color:#cfcfd6;")}>Suggest commands from history</div><div style={css("font-size:10.5px;color:#54545e;margin-top:2px;")}>Default for new tabs — toggle per tab in the status bar.</div></div>
                    <div onClick={v.toggleCmdSuggest} style={v.cmdSuggestTrack}><span style={v.cmdSuggestKnob}></span></div>
                  </div>
                </div>

                <div>
                  <div style={css("font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#ff7a59;margin-bottom:12px;")}>Behaviour &amp; Security</div>
                  <div style={css("display:flex;align-items:center;gap:12px;margin-bottom:14px;")}>
                    <div style={css("flex:1;")}><div style={css("font-size:12px;color:#cfcfd6;")}>Confirm before closing a session</div></div>
                    <div onClick={v.toggleConfirmClose} style={v.confirmCloseTrack}><span style={v.confirmCloseKnob}></span></div>
                  </div>
                  <div style={css("display:flex;align-items:center;gap:12px;margin-bottom:14px;")}>
                    <div style={css("flex:1;")}><div style={css("font-size:12px;color:#cfcfd6;")}>Restore tabs on launch</div></div>
                    <div onClick={v.toggleRestoreTabs} style={v.restoreTabsTrack}><span style={v.restoreTabsKnob}></span></div>
                  </div>
                  <div style={css("display:flex;align-items:center;gap:12px;")}>
                    <div style={css("flex:1;")}><div style={css("font-size:12px;color:#cfcfd6;")}>Lock vault after idle</div><div style={css("font-size:10.5px;color:#54545e;margin-top:2px;")}>Re-enter passphrase after 15 min</div></div>
                    <div onClick={v.toggleLockIdle} style={v.lockIdleTrack}><span style={v.lockIdleKnob}></span></div>
                  </div>
                </div>

                <div>
                  <div style={css("font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#ff7a59;margin-bottom:12px;")}>AI agent access</div>
                  <div style={css("display:flex;align-items:center;gap:10px;padding:12px 14px;background:#0e0e12;border:1px solid #1c1c24;border-radius:9px;")}>
                    <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: v.mcpRunning ? '#46d9a0' : '#54545e', flex: 'none' }}></span>
                    <div style={css("flex:1;")}>
                      <div style={css("font-size:11.5px;color:#cfcfd6;")}>MCP server {v.mcpRunning ? '· running' : '· stopped'}</div>
                      <div style={css("font-size:10.5px;color:#54545e;margin-top:2px;")}>Let an AI agent use selected hosts, with per-command approval.</div>
                    </div>
                    <Hov as="button" onClick={v.openMcp} s="padding:7px 12px;background:#101015;border:1px solid #20202a;border-radius:7px;color:#b9b9c2;font:inherit;font-size:11px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Manage</Hov>
                  </div>
                </div>

                <div>
                  <div style={css("font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#ff7a59;margin-bottom:12px;")}>Local data</div>
                  <div style={css("display:flex;align-items:center;gap:10px;padding:12px 14px;background:#0e0e12;border:1px solid #1c1c24;border-radius:9px;")}>
                    <span style={css("width:7px;height:7px;border-radius:50%;background:#46d9a0;box-shadow:0 0 7px rgba(70,217,160,.6);flex:none;")}></span>
                    <span style={css("flex:1;font-size:11.5px;color:#9a9aa3;")}>Stored on this device, encrypted at rest</span>
                    <Hov as="button" onClick={v.onImportOne} title="Import a single connection file" s="padding:7px 12px;background:#101015;border:1px solid #20202a;border-radius:7px;color:#b9b9c2;font:inherit;font-size:11px;cursor:pointer;flex:none;" h="background:#16161c;color:#ededf0;">Import connection</Hov>
                    <Hov as="button" onClick={v.onImport} s="padding:7px 12px;background:#101015;border:1px solid #20202a;border-radius:7px;color:#b9b9c2;font:inherit;font-size:11px;cursor:pointer;flex:none;" h="background:#16161c;color:#ededf0;">Import</Hov>
                    <Hov as="button" onClick={v.onExport} s="padding:7px 12px;background:#101015;border:1px solid #20202a;border-radius:7px;color:#b9b9c2;font:inherit;font-size:11px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Export</Hov>
                  </div>
                </div>

                <div>
                  <div style={css("font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#ff7a59;margin-bottom:12px;")}>Updates</div>
                  <div style={css("display:flex;align-items:center;gap:10px;padding:12px 14px;background:#0e0e12;border:1px solid #1c1c24;border-radius:9px;")}>
                    <div style={css("flex:1;")}>
                      <div style={css("font-size:11.5px;color:#9a9aa3;")}>{v.updateInfo ? ('Version ' + v.updateInfo.version + ' is available') : 'You are on the latest version'}</div>
                      <div style={css("font-size:10px;color:#54545e;margin-top:2px;")}>Current · v{v.appVersion}</div>
                    </div>
                    {v.updateInfo ? (
                      <Hov as="button" onClick={v.doDownloadUpdate} s="padding:7px 14px;background:#ff7a59;border:none;border-radius:7px;color:#0c0b0a;font:inherit;font-size:11px;font-weight:700;cursor:pointer;flex:none;" h="background:#ff8d70;">Download v{v.updateInfo.version}</Hov>
                    ) : (
                      <Hov as="button" onClick={v.doCheckUpdate} s="padding:7px 12px;background:#101015;border:1px solid #20202a;border-radius:7px;color:#b9b9c2;font:inherit;font-size:11px;cursor:pointer;flex:none;" h="background:#16161c;color:#ededf0;">{v.updateChecking ? 'Checking…' : 'Check for updates'}</Hov>
                    )}
                  </div>
                </div>

                <div>
                  <div style={css("font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#ff6b78;margin-bottom:12px;")}>Danger zone</div>
                  <div style={css("display:flex;align-items:center;gap:10px;padding:12px 14px;background:#0e0e12;border:1px solid rgba(255,107,120,.25);border-radius:9px;")}>
                    <span style={css("flex:1;font-size:11.5px;color:#9a9aa3;")}>Permanently delete all saved connections, settings, and stored secrets.</span>
                    <Hov as="button" onClick={v.openClearConfirm} s="padding:7px 12px;background:rgba(255,107,120,.12);border:1px solid rgba(255,107,120,.4);border-radius:7px;color:#ff6b78;font:inherit;font-size:11px;font-weight:600;cursor:pointer;flex:none;" h="background:rgba(255,107,120,.2);">Clear all data</Hov>
                  </div>
                </div>

              </div>
              <div style={css("flex:none;display:flex;align-items:center;padding:14px 22px;border-top:1px solid #18181f;")}>
                <span style={css("font-size:10.5px;color:#54545e;")}>SSH Ache · v{v.appVersion}</span>
                <span style={css("flex:1;")}></span>
                <Hov as="button" onClick={v.closeSettings} s="padding:9px 18px;background:#ff7a59;border:none;border-radius:8px;color:#0c0b0a;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;" h="background:#ff8d70;">Done</Hov>
              </div>
            </div>
          </div>
        )}

        {/* CLEAR ALL DATA — confirmation */}
        {v.clearConfirmOpen && (
          <div onClick={v.cancelClearConfirm} style={css("position:absolute;inset:0;background:rgba(5,5,7,.74);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:32px;z-index:85;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:404px;max-width:96%;background:#0c0c10;border:1px solid rgba(255,107,120,.3);border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.6);padding:26px 24px;text-align:center;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("width:52px;height:52px;margin:0 auto;border-radius:14px;display:flex;align-items:center;justify-content:center;background:rgba(255,107,120,.12);border:1px solid rgba(255,107,120,.35);color:#ff6b78;font-size:24px;")}>⚠</div>
              <div style={css("font-size:16px;font-weight:700;color:#f2f2f5;margin-top:16px;")}>Clear all data?</div>
              <div style={css("font-size:12.5px;color:#9a9aa3;margin-top:9px;line-height:1.6;")}>This permanently deletes every saved connection, your settings, and all secrets stored in the OS keychain. This can't be undone.</div>
              <div style={css("display:flex;gap:10px;margin-top:22px;")}>
                <Hov as="button" onClick={v.cancelClearConfirm} s="flex:1;padding:11px;background:#101015;border:1px solid #20202a;border-radius:9px;color:#b9b9c2;font:inherit;font-size:12.5px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Cancel</Hov>
                <Hov as="button" onClick={v.doClearAll} s="flex:1;padding:11px;background:#ff6b78;border:none;border-radius:9px;color:#0c0b0a;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;" h="background:#ff8591;">Delete everything</Hov>
              </div>
            </div>
          </div>
        )}

        {/* CONNECT SECRET PROMPT */}
        {v.secretPromptOpen && (
          <div onClick={v.cancelSecret} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:32px;z-index:75;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:380px;max-width:94%;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("padding:18px 20px 4px;font-size:14px;font-weight:700;color:#f2f2f5;")}>{v.secretPromptTitle}</div>
              <div style={css("padding:8px 20px 18px;display:flex;flex-direction:column;gap:9px;")}>
                <div style={css("font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;")}>{v.secretPromptLabel}</div>
                <input value={v.secretValue} onChange={v.onSecretInput} onKeyDown={v.onSecretKey} type="password" autoFocus spellCheck={false} style={css("width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;")} />
                <div style={css("font-size:10.5px;color:#54545e;")}>{v.secretPromptHint}</div>
              </div>
              <div style={css("display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid #18181f;")}>
                <Hov as="button" onClick={v.cancelSecret} s="padding:9px 14px;background:#101015;border:1px solid #20202a;border-radius:8px;color:#b9b9c2;font:inherit;font-size:12.5px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Cancel</Hov>
                <Hov as="button" onClick={v.submitSecret} s="padding:9px 16px;background:#ff7a59;border:none;border-radius:8px;color:#0c0b0a;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;" h="background:#ff8d70;">Connect</Hov>
              </div>
            </div>
          </div>
        )}

        {/* HOST KEY CONFIRM (first-seen) */}
        {v.hostKeyOpen && (
          <div onClick={v.rejectHostKey} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:32px;z-index:75;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:460px;max-width:96%;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("display:flex;align-items:center;gap:11px;padding:18px 20px 8px;")}>
                <span style={css("width:26px;height:26px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:7px;background:rgba(255,122,89,.12);color:#ff7a59;font-size:14px;")}>⚿</span>
                <div style={css("flex:1;")}>
                  <div style={css("font-size:14px;font-weight:700;color:#f2f2f5;")}>Unknown host key</div>
                  <div style={css("font-size:11px;color:#6a6a74;margin-top:1px;")}>{v.hostKeyName} · {v.hostKeyTarget}</div>
                </div>
              </div>
              <div style={css("padding:4px 20px 16px;display:flex;flex-direction:column;gap:10px;")}>
                <div style={css("font-size:12px;color:#cfcfd6;line-height:1.5;")}>First time connecting to this server. Verify the SHA256 fingerprint matches the server's real key before trusting it.</div>
                <div style={css("font-size:11.5px;color:#ededf0;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:10px 12px;word-break:break-all;")}>{v.hostKeyFp}</div>
                <div style={css("font-size:10.5px;color:#54545e;")}>Trusting adds it to ~/.ssh/known_hosts; you won't be asked again.</div>
              </div>
              <div style={css("display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid #18181f;")}>
                <Hov as="button" onClick={v.rejectHostKey} s="padding:9px 14px;background:#101015;border:1px solid #20202a;border-radius:8px;color:#b9b9c2;font:inherit;font-size:12.5px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Reject</Hov>
                <Hov as="button" onClick={v.acceptHostKey} s="padding:9px 16px;background:#ff7a59;border:none;border-radius:8px;color:#0c0b0a;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;" h="background:#ff8d70;">Trust &amp; connect</Hov>
              </div>
            </div>
          </div>
        )}

        {/* EDIT FOLDER */}
        {v.folderEditOpen && (
          <div onClick={v.cancelFolderEdit} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:32px;z-index:79;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:400px;max-width:94%;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("padding:18px 20px 4px;font-size:14px;font-weight:700;color:#f2f2f5;")}>Edit folder</div>
              <div style={css("padding:10px 20px 16px;display:flex;flex-direction:column;gap:14px;")}>
                <div>
                  <div style={css("font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:7px;")}>Name</div>
                  <input value={v.folderEditName} onChange={v.onFolderEditName} autoFocus spellCheck={false} style={css("width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:10px 12px;color:#ededf0;font:inherit;font-size:13px;outline:none;")} />
                </div>
                <div>
                  <div style={css("font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:7px;")}>Color</div>
                  <div style={css("display:flex;gap:8px;flex-wrap:wrap;")}>
                    {v.folderPalette.map((c, i) => (
                      <span key={i} onClick={() => v.pickFolderColor(c)} style={{ width: '22px', height: '22px', borderRadius: '6px', background: c, cursor: 'pointer', border: '2px solid ' + (v.folderEditColor === c ? '#ededf0' : 'transparent'), boxShadow: '0 0 0 1px rgba(255,255,255,.08)' }}></span>
                    ))}
                  </div>
                </div>
                <div style={css("display:flex;align-items:center;gap:12px;")}>
                  <div style={css("flex:1;font-size:12px;color:#cfcfd6;")}>Favorite <span style={css("color:#54545e;")}>· show at top</span></div>
                  <div onClick={v.toggleFolderEditFav} style={{ width: '38px', height: '22px', borderRadius: '11px', background: v.folderEditFav ? '#ff7a59' : '#26262e', position: 'relative', cursor: 'pointer', flex: 'none' }}>
                    <span style={{ position: 'absolute', top: '2px', left: v.folderEditFav ? '18px' : '2px', width: '18px', height: '18px', borderRadius: '50%', background: '#fff', transition: 'left .15s ease' }}></span>
                  </div>
                </div>
              </div>
              <div style={css("display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid #18181f;")}>
                <Hov as="button" onClick={v.cancelFolderEdit} s="padding:9px 14px;background:#101015;border:1px solid #20202a;border-radius:8px;color:#b9b9c2;font:inherit;font-size:12.5px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Cancel</Hov>
                <Hov as="button" onClick={v.saveFolderEdit} s="padding:9px 16px;background:#ff7a59;border:none;border-radius:8px;color:#0c0b0a;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;" h="background:#ff8d70;">Save</Hov>
              </div>
            </div>
          </div>
        )}

        {/* ADD PORT FORWARD */}
        {v.fwdOpen && (
          <div onClick={v.cancelForward} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:32px;z-index:79;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:470px;max-width:96%;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("padding:18px 20px 4px;font-size:14px;font-weight:700;color:#f2f2f5;")}>{v.fwdMode === 'socks' ? 'Add dynamic SOCKS proxy' : v.fwdMode === 'remote' ? 'Add remote forward' : 'Add port forward'} <span style={css("color:#6a6a74;font-weight:400;")}>({v.fwdMode === 'socks' ? 'dynamic · -D' : v.fwdMode === 'remote' ? 'remote · -R' : 'local · -L'})</span></div>
              <div style={css("padding:10px 20px 16px;display:flex;flex-direction:column;gap:10px;")}>
                {v.fwdMode === 'socks' ? (
                  <>
                    <div style={css("width:120px;")}>
                      <div style={css("font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:6px;")}>Local port</div>
                      <input value={v.fwdLocal} onChange={v.onFwdLocal} placeholder="1080" autoFocus spellCheck={false} style={css("width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:10px 11px;color:#ededf0;font:inherit;font-size:13px;outline:none;")} />
                    </div>
                    <div style={css("font-size:10.5px;color:#54545e;line-height:1.5;")}>Point apps at <span style={css("color:#9a9aa3;")}>socks5h://localhost:{v.fwdLocal || '…'}</span> — each request is tunnelled to its target over this SSH session.</div>
                  </>
                ) : v.fwdMode === 'remote' ? (
                  <>
                    <div style={css("display:flex;align-items:flex-end;gap:8px;")}>
                      <div style={css("width:96px;")}>
                        <div style={css("font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:6px;")}>Remote port</div>
                        <input value={v.fwdRemotePort} onChange={v.onFwdRemotePort} placeholder="8000" autoFocus spellCheck={false} style={css("width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:10px 11px;color:#ededf0;font:inherit;font-size:13px;outline:none;")} />
                      </div>
                      <span style={css("color:#54545e;padding-bottom:11px;")}>→</span>
                      <div style={css("flex:1;")}>
                        <div style={css("font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:6px;")}>Local host</div>
                        <input value={v.fwdRemoteHost} onChange={v.onFwdRemoteHost} placeholder="127.0.0.1" spellCheck={false} style={css("width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:10px 11px;color:#ededf0;font:inherit;font-size:13px;outline:none;")} />
                      </div>
                      <span style={css("color:#54545e;padding-bottom:11px;")}>:</span>
                      <div style={css("width:88px;")}>
                        <div style={css("font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:6px;")}>Local port</div>
                        <input value={v.fwdLocal} onChange={v.onFwdLocal} placeholder="3000" spellCheck={false} style={css("width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:10px 11px;color:#ededf0;font:inherit;font-size:13px;outline:none;")} />
                      </div>
                    </div>
                    <div style={css("font-size:10.5px;color:#54545e;line-height:1.5;")}>The server listens on <span style={css("color:#9a9aa3;")}>:{v.fwdRemotePort || '…'}</span> and forwards back to <span style={css("color:#9a9aa3;")}>{v.fwdRemoteHost || '…'}:{v.fwdLocal || '…'}</span>. Needs <span style={css("color:#9a9aa3;")}>GatewayPorts</span> on the server for non-localhost binds.</div>
                  </>
                ) : (
                  <>
                    <div style={css("display:flex;align-items:flex-end;gap:8px;")}>
                      <div style={css("width:88px;")}>
                        <div style={css("font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:6px;")}>Local port</div>
                        <input value={v.fwdLocal} onChange={v.onFwdLocal} placeholder="8080" autoFocus spellCheck={false} style={css("width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:10px 11px;color:#ededf0;font:inherit;font-size:13px;outline:none;")} />
                      </div>
                      <span style={css("color:#54545e;padding-bottom:11px;")}>→</span>
                      <div style={css("flex:1;")}>
                        <div style={css("font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:6px;")}>Remote host</div>
                        <input value={v.fwdRemoteHost} onChange={v.onFwdRemoteHost} placeholder="127.0.0.1" spellCheck={false} style={css("width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:10px 11px;color:#ededf0;font:inherit;font-size:13px;outline:none;")} />
                      </div>
                      <span style={css("color:#54545e;padding-bottom:11px;")}>:</span>
                      <div style={css("width:88px;")}>
                        <div style={css("font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;margin-bottom:6px;")}>Remote port</div>
                        <input value={v.fwdRemotePort} onChange={v.onFwdRemotePort} placeholder="5432" spellCheck={false} style={css("width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:10px 11px;color:#ededf0;font:inherit;font-size:13px;outline:none;")} />
                      </div>
                    </div>
                    <div style={css("font-size:10.5px;color:#54545e;line-height:1.5;")}>Connections to <span style={css("color:#9a9aa3;")}>localhost:{v.fwdLocal || '…'}</span> tunnel to <span style={css("color:#9a9aa3;")}>{v.fwdRemoteHost || '…'}:{v.fwdRemotePort || '…'}</span> over this SSH session.</div>
                  </>
                )}
              </div>
              <div style={css("display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid #18181f;")}>
                <Hov as="button" onClick={v.cancelForward} s="padding:9px 14px;background:#101015;border:1px solid #20202a;border-radius:8px;color:#b9b9c2;font:inherit;font-size:12.5px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Cancel</Hov>
                <Hov as="button" onClick={v.submitForward} s="padding:9px 16px;background:#ff7a59;border:none;border-radius:8px;color:#0c0b0a;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;" h="background:#ff8d70;">{v.fwdMode === 'socks' ? 'Start proxy' : v.fwdMode === 'remote' ? 'Start remote forward' : 'Start forward'}</Hov>
              </div>
            </div>
          </div>
        )}

        {/* SFTP mkdir / rename / delete */}
        {v.sftpPrompt && (
          <div onClick={v.sftpPromptCancel} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:32px;z-index:79;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:380px;max-width:94%;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("padding:18px 20px 4px;font-size:14px;font-weight:700;color:#f2f2f5;")}>{v.sftpPromptTitle}</div>
              <div style={css("padding:8px 20px 18px;display:flex;flex-direction:column;gap:9px;")}>
                {v.sftpPrompt.mode === 'delete' ? (
                  <div style={css("font-size:11.5px;color:#9a9aa3;line-height:1.5;")}>This permanently deletes the selected remote item(s){v.sftpPrompt.names && v.sftpPrompt.names.length ? ': ' : '.'}<span style={css("color:#ededf0;")}>{(v.sftpPrompt.names || []).join(', ')}</span>. Folders are removed recursively.</div>
                ) : (
                  <input value={v.sftpPrompt.value || ''} onChange={v.onSftpPromptValue} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); v.sftpPromptSubmit(); } else if (e.key === 'Escape') { v.sftpPromptCancel(); } }} autoFocus spellCheck={false} placeholder={v.sftpPrompt.mode === 'mkdir' ? 'folder name' : 'new name'} style={css("width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;")} />
                )}
              </div>
              <div style={css("display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid #18181f;")}>
                <Hov as="button" onClick={v.sftpPromptCancel} s="padding:9px 14px;background:#101015;border:1px solid #20202a;border-radius:8px;color:#b9b9c2;font:inherit;font-size:12.5px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Cancel</Hov>
                <Hov as="button" onClick={v.sftpPromptSubmit} s={"padding:9px 16px;border:none;border-radius:8px;color:#0c0b0a;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;background:" + (v.sftpPrompt.mode === 'delete' ? '#ff6b78' : '#ff7a59') + ";"} h={v.sftpPrompt.mode === 'delete' ? 'background:#ff8088;' : 'background:#ff8d70;'}>{v.sftpPrompt.mode === 'delete' ? 'Delete' : v.sftpPrompt.mode === 'mkdir' ? 'Create' : 'Rename'}</Hov>
              </div>
            </div>
          </div>
        )}

        {/* SET VAULT PASSPHRASE */}
        {v.lockSetOpen && (
          <div onClick={v.cancelLockSet} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:32px;z-index:79;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:380px;max-width:94%;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("padding:18px 20px 4px;font-size:14px;font-weight:700;color:#f2f2f5;")}>Set a vault passphrase</div>
              <div style={css("padding:8px 20px 18px;display:flex;flex-direction:column;gap:9px;")}>
                <div style={css("font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;")}>Passphrase</div>
                <input value={v.lockSetValue} onChange={v.onLockSetInput} onKeyDown={v.onLockSetKey} type="password" autoFocus spellCheck={false} style={css("width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;")} />
                <div style={css("font-size:10.5px;color:#54545e;line-height:1.5;")}>Required to unlock after 15 min idle. Stored as a hash — not recoverable.</div>
              </div>
              <div style={css("display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid #18181f;")}>
                <Hov as="button" onClick={v.cancelLockSet} s="padding:9px 14px;background:#101015;border:1px solid #20202a;border-radius:8px;color:#b9b9c2;font:inherit;font-size:12.5px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Cancel</Hov>
                <Hov as="button" onClick={v.submitLockSet} s="padding:9px 16px;background:#ff7a59;border:none;border-radius:8px;color:#0c0b0a;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;" h="background:#ff8d70;">Enable lock</Hov>
              </div>
            </div>
          </div>
        )}

        {/* VAULT LOCKED */}
        {v.locked && (
          <div style={css("position:absolute;inset:0;background:#09090b;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;z-index:95;animation:acaFade .15s ease;")}>
            <span style={css("width:34px;height:34px;background:#ff7a59;border-radius:8px;transform:rotate(45deg);box-shadow:0 0 24px rgba(255,122,89,.5);")}></span>
            <div style={css("font-size:16px;font-weight:700;color:#f2f2f5;margin-top:6px;")}>SSH Ache is locked</div>
            <div style={css("font-size:11.5px;color:#6a6a74;")}>Enter your vault passphrase to unlock.</div>
            <div style={css("display:flex;gap:8px;margin-top:4px;")}>
              <input value={v.unlockValue} onChange={v.onUnlockInput} onKeyDown={v.onUnlockKey} type="password" autoFocus spellCheck={false} placeholder="Passphrase" style={css("width:240px;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;")} />
              <Hov as="button" onClick={v.submitUnlock} s="padding:11px 18px;background:#ff7a59;border:none;border-radius:8px;color:#0c0b0a;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;" h="background:#ff8d70;">Unlock</Hov>
            </div>
          </div>
        )}

        {/* IMPORT / EXPORT PASSWORD */}
        {v.ioOpen && (
          <div onClick={v.ioCancel} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:32px;z-index:79;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:400px;max-width:94%;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("padding:18px 20px 4px;font-size:14px;font-weight:700;color:#f2f2f5;")}>{v.ioTitle}</div>
              <div style={css("padding:8px 20px 18px;display:flex;flex-direction:column;gap:9px;")}>
                <div style={css("font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a74;")}>{v.ioLabel}</div>
                <input value={v.ioValue} onChange={v.onIoInput} onKeyDown={v.onIoKey} type="password" autoFocus spellCheck={false} style={css("width:100%;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;color:#ededf0;font:inherit;font-size:13px;outline:none;")} />
                <div style={css("font-size:10.5px;color:#54545e;line-height:1.5;")}>{v.ioHint}</div>
              </div>
              <div style={css("display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid #18181f;")}>
                <Hov as="button" onClick={v.ioCancel} s="padding:9px 14px;background:#101015;border:1px solid #20202a;border-radius:8px;color:#b9b9c2;font:inherit;font-size:12.5px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Cancel</Hov>
                <Hov as="button" onClick={v.ioSubmit} s="padding:9px 16px;background:#ff7a59;border:none;border-radius:8px;color:#0c0b0a;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;" h="background:#ff8d70;">{v.ioCta}</Hov>
              </div>
            </div>
          </div>
        )}

        {/* CONFIRM CLOSE SESSION */}
        {v.confirmCloseOpen && (
          <div onClick={v.cancelConfirmClose} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:32px;z-index:78;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:380px;max-width:94%;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("padding:18px 20px 4px;font-size:14px;font-weight:700;color:#f2f2f5;")}>Close session?</div>
              <div style={css("padding:8px 20px 18px;font-size:12px;color:#cfcfd6;line-height:1.5;")}>End the SSH connection to <span style={css("color:#ededf0;font-weight:600;")}>{v.confirmCloseName}</span>? Any running command stops.</div>
              <div style={css("display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid #18181f;")}>
                <Hov as="button" onClick={v.cancelConfirmClose} s="padding:9px 14px;background:#101015;border:1px solid #20202a;border-radius:8px;color:#b9b9c2;font:inherit;font-size:12.5px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Cancel</Hov>
                <Hov as="button" onClick={v.confirmCloseTab} s="padding:9px 16px;background:transparent;border:1px solid rgba(255,107,120,.45);border-radius:8px;color:#ff6b78;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;" h="background:rgba(255,107,120,.12);">Close session</Hov>
              </div>
            </div>
          </div>
        )}

        {/* MCP — AI AGENT ACCESS */}
        {v.mcpOpen && (
          <div onClick={v.closeMcp} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:40px;z-index:66;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:660px;max-width:96%;max-height:88vh;display:flex;flex-direction:column;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("display:flex;align-items:center;gap:11px;padding:18px 22px;border-bottom:1px solid #18181f;")}>
                <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: v.mcpRunning ? '#46d9a0' : '#54545e', boxShadow: v.mcpRunning ? '0 0 7px rgba(70,217,160,.6)' : 'none', flex: 'none' }}></span>
                <div style={css("flex:1;")}>
                  <div style={css("font-size:15px;font-weight:700;color:#f2f2f5;")}>AI agent access · MCP</div>
                  <div style={css("font-size:11px;color:#6a6a74;margin-top:2px;")}>{v.mcpRunning ? 'Running on 127.0.0.1' : 'Stopped'} · {v.mcpExposedCount} host(s) exposed</div>
                </div>
                <Hov as="button" onClick={v.toggleMcp} s={v.mcpRunning ? "padding:8px 16px;background:transparent;border:1px solid rgba(255,107,120,.4);border-radius:8px;color:#ff6b78;font:inherit;font-size:12px;cursor:pointer;" : "padding:8px 16px;background:#ff7a59;border:none;border-radius:8px;color:#0c0b0a;font:inherit;font-size:12px;font-weight:600;cursor:pointer;"} h={v.mcpRunning ? "background:rgba(255,107,120,.12);" : "background:#ff8d70;"}>{v.mcpRunning ? 'Stop' : 'Start'}</Hov>
                <span onClick={v.closeMcp} style={css("width:26px;height:26px;display:flex;align-items:center;justify-content:center;color:#8b8b95;border:1px solid #26262e;border-radius:6px;cursor:pointer;")}>×</span>
              </div>
              <div style={css("flex:1;overflow:auto;padding:18px 22px;display:flex;flex-direction:column;gap:20px;")}>
                <div style={css("display:flex;gap:9px;padding:11px 13px;background:rgba(70,217,160,.05);border:1px solid rgba(70,217,160,.2);border-radius:9px;")}>
                  <span style={css("color:#46d9a0;flex:none;")}>⚿</span>
                  <div style={css("font-size:11px;color:#9a9aa3;line-height:1.55;")}>Bound to <span style={css("color:#cfcfd6;")}>localhost</span> behind a bearer token. Only the hosts you enable below are visible. <span style={css("color:#cfcfd6;")}>Every command needs your approval, unless you turn on Auto-allow for a host.</span> Secrets are never sent to the agent.</div>
                </div>

                {v.mcpRunning && (
                  <div style={css("display:flex;flex-direction:column;gap:10px;")}>
                    <div style={css("font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#ff7a59;")}>Connection</div>
                    <div style={css("display:flex;align-items:center;gap:8px;")}>
                      <span style={css("font-size:10.5px;color:#6a6a74;width:48px;flex:none;")}>URL</span>
                      <span style={css("flex:1;font-size:11.5px;color:#ededf0;background:#0e0e12;border:1px solid #20202a;border-radius:7px;padding:8px 11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{v.mcpUrl}</span>
                      <Hov as="button" onClick={() => v.copyMcp(v.mcpUrl)} s="padding:8px 11px;background:#101015;border:1px solid #20202a;border-radius:7px;color:#b9b9c2;font:inherit;font-size:11px;cursor:pointer;flex:none;" h="background:#16161c;color:#ededf0;">Copy</Hov>
                    </div>
                    <div style={css("display:flex;align-items:center;gap:8px;")}>
                      <span style={css("font-size:10.5px;color:#6a6a74;width:48px;flex:none;")}>Token</span>
                      <span style={css("flex:1;font-size:11.5px;color:#9a9aa3;background:#0e0e12;border:1px solid #20202a;border-radius:7px;padding:8px 11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{v.mcpToken.slice(0, 8)}…{v.mcpToken.slice(-4)}</span>
                      <Hov as="button" onClick={() => v.copyMcp(v.mcpToken)} s="padding:8px 11px;background:#101015;border:1px solid #20202a;border-radius:7px;color:#b9b9c2;font:inherit;font-size:11px;cursor:pointer;flex:none;" h="background:#16161c;color:#ededf0;">Copy</Hov>
                    </div>
                    <div style={css("display:flex;align-items:flex-start;gap:8px;")}>
                      <span style={css("font-size:10.5px;color:#6a6a74;width:48px;flex:none;margin-top:8px;")}>Config</span>
                      <pre style={css("flex:1;margin:0;font-size:10.5px;color:#9a9aa3;background:#0e0e12;border:1px solid #20202a;border-radius:7px;padding:10px 12px;overflow:auto;white-space:pre;")}>{v.mcpConfig}</pre>
                      <Hov as="button" onClick={() => v.copyMcp(v.mcpConfig)} s="padding:8px 11px;background:#101015;border:1px solid #20202a;border-radius:7px;color:#b9b9c2;font:inherit;font-size:11px;cursor:pointer;flex:none;margin-top:0;" h="background:#16161c;color:#ededf0;">Copy</Hov>
                    </div>
                  </div>
                )}

                <div style={css("display:flex;flex-direction:column;gap:8px;")}>
                  <div style={css("font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#ff7a59;")}>Hosts the agent may use</div>
                  {v.mcpHosts.length === 0 && (<div style={css("font-size:11.5px;color:#54545e;")}>No hosts yet.</div>)}
                  {v.mcpHosts.map((h) => (
                    <div key={h.id} style={css("display:flex;align-items:center;gap:10px;padding:9px 12px;background:#0e0e12;border:1px solid #1c1c24;border-radius:8px;")}>
                      <div style={css("flex:1;min-width:0;")}>
                        <div style={css("font-size:12px;color:#ededf0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{h.name}</div>
                        <div style={css("font-size:10.5px;color:#6a6a74;margin-top:1px;")}>{h.target}</div>
                      </div>
                      {h.allowed && (
                        <div onClick={h.onToggleAuto} title="Auto-allow: run agent commands on this host without a prompt" style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', flex: 'none' }}>
                          <span style={{ fontSize: '9px', letterSpacing: '.1em', color: h.auto ? '#ffcf5c' : '#54545e' }}>AUTO</span>
                          <div style={{ width: '32px', height: '18px', borderRadius: '9px', background: h.auto ? '#ffcf5c' : '#26262e', position: 'relative' }}>
                            <span style={{ position: 'absolute', top: '2px', left: h.auto ? '16px' : '2px', width: '14px', height: '14px', borderRadius: '50%', background: '#fff', transition: 'left .15s ease' }}></span>
                          </div>
                        </div>
                      )}
                      <div onClick={h.onToggle} style={{ width: '38px', height: '22px', borderRadius: '11px', background: h.allowed ? '#46d9a0' : '#26262e', position: 'relative', cursor: 'pointer', flex: 'none' }}>
                        <span style={{ position: 'absolute', top: '2px', left: h.allowed ? '18px' : '2px', width: '18px', height: '18px', borderRadius: '50%', background: '#fff', transition: 'left .15s ease' }}></span>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={css("display:flex;flex-direction:column;gap:6px;")}>
                  <div style={css("font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#ff7a59;")}>Recent activity</div>
                  {(!v.mcpLog || v.mcpLog.length === 0) && (<div style={css("font-size:11.5px;color:#54545e;")}>No commands yet.</div>)}
                  {(v.mcpLog || []).slice(-12).reverse().map((l, i) => (
                    <div key={i} style={css("display:flex;align-items:center;gap:8px;font-size:11px;padding:6px 2px;")}>
                      <span style={{ color: l.allowed ? '#46d9a0' : '#ff6b78', flex: 'none' }}>{l.allowed ? '✓' : '✕'}</span>
                      <span style={css("color:#9a9aa3;flex:none;")}>{l.host}</span>
                      {l.auto && (<span style={css("font-size:8.5px;letter-spacing:.08em;color:#ffcf5c;border:1px solid #4a3f1e;border-radius:4px;padding:0 4px;flex:none;")}>AUTO</span>)}
                      <span style={css("color:#cfcfd6;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:inherit;")}>{l.command}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* MCP COMMAND APPROVAL */}
        {v.approvalOpen && (
          <div style={css("position:absolute;inset:0;background:rgba(5,5,7,.72);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:32px;z-index:90;animation:acaFade .12s ease;")}>
            <div style={css("width:500px;max-width:96%;background:#0c0c10;border:1px solid rgba(255,122,89,.4);border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("display:flex;align-items:center;gap:11px;padding:18px 20px 8px;")}>
                <span style={css("width:26px;height:26px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:7px;background:rgba(255,122,89,.12);color:#ff7a59;font-size:14px;")}>›_</span>
                <div style={css("flex:1;")}>
                  <div style={css("font-size:14px;font-weight:700;color:#f2f2f5;")}>Agent wants to run a command</div>
                  <div style={css("font-size:11px;color:#6a6a74;margin-top:1px;")}>on <span style={css("color:#cfcfd6;")}>{v.approvalHost}</span></div>
                </div>
              </div>
              <div style={css("padding:6px 20px 14px;")}>
                <pre style={css("margin:0;font-size:12px;color:#ededf0;background:#0e0e12;border:1px solid #20202a;border-radius:8px;padding:11px 13px;overflow:auto;white-space:pre-wrap;word-break:break-word;")}>{v.approvalCommand}</pre>
                <div style={css("font-size:10.5px;color:#54545e;margin-top:9px;")}>Approve only if you trust this command. It runs with this host's saved credentials.</div>
              </div>
              <div style={css("display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid #18181f;")}>
                <Hov as="button" onClick={v.deny} s="padding:9px 16px;background:#101015;border:1px solid #20202a;border-radius:8px;color:#b9b9c2;font:inherit;font-size:12.5px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Deny</Hov>
                <Hov as="button" onClick={v.approve} s="padding:9px 18px;background:#ff7a59;border:none;border-radius:8px;color:#0c0b0a;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;" h="background:#ff8d70;">Approve &amp; run</Hov>
              </div>
            </div>
          </div>
        )}

        {/* SFTP FILE-EXISTS CONFLICT */}
        {v.conflictOpen && (
          <div onClick={v.conflictSkip} style={css("position:absolute;inset:0;background:rgba(5,5,7,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:32px;z-index:78;animation:acaFade .12s ease;")}>
            <div onClick={v.stop} style={css("width:420px;max-width:94%;background:#0c0c10;border:1px solid #26262e;border-radius:14px;box-shadow:0 36px 90px rgba(0,0,0,.65);overflow:hidden;animation:acaModal .18s cubic-bezier(.2,.8,.2,1);")}>
              <div style={css("padding:18px 20px 4px;font-size:14px;font-weight:700;color:#f2f2f5;")}>File already exists</div>
              <div style={css("padding:8px 20px 14px;font-size:12px;color:#cfcfd6;line-height:1.55;")}><span style={css("color:#ededf0;font-weight:600;")}>{v.conflictName}</span> already exists in <span style={css("color:#9a9aa3;")}>{v.conflictDest}</span>. Replace it or skip?</div>
              <div style={css("display:flex;align-items:center;gap:12px;padding:0 20px 14px;")}>
                <div style={css("flex:1;font-size:12px;color:#cfcfd6;")}>Apply to all</div>
                <div onClick={v.toggleConflictAll} style={{ width: '38px', height: '22px', borderRadius: '11px', background: v.conflictAll ? '#ff7a59' : '#26262e', position: 'relative', cursor: 'pointer', flex: 'none' }}>
                  <span style={{ position: 'absolute', top: '2px', left: v.conflictAll ? '18px' : '2px', width: '18px', height: '18px', borderRadius: '50%', background: '#fff', transition: 'left .15s ease' }}></span>
                </div>
              </div>
              <div style={css("display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid #18181f;")}>
                <Hov as="button" onClick={v.conflictSkip} s="padding:9px 14px;background:#101015;border:1px solid #20202a;border-radius:8px;color:#b9b9c2;font:inherit;font-size:12.5px;cursor:pointer;" h="background:#16161c;color:#ededf0;">Skip</Hov>
                <Hov as="button" onClick={v.conflictReplace} s="padding:9px 16px;background:#ff7a59;border:none;border-radius:8px;color:#0c0b0a;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;" h="background:#ff8d70;">Replace</Hov>
              </div>
            </div>
          </div>
        )}

        {/* TOASTS */}
        <div style={css("position:absolute;right:18px;bottom:18px;display:flex;flex-direction:column;gap:10px;z-index:80;align-items:flex-end;")}>
          {v.toasts.map((t, i) => (
            <div key={i} style={t.style}>
              <span style={t.iconStyle}>{t.icon}</span>
              <div style={css("min-width:0;")}>
                <div style={css("font-size:12.5px;font-weight:600;color:#ededf0;")}>{t.title}</div>
                <div style={css("font-size:11px;color:#8b8b95;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;")}>{t.msg}</div>
              </div>
            </div>
          ))}
        </div>

      </div>
    );
  }
}
