# SSH Ache — Build Plan

Staged plan to turn the Claude Design mock (`SSH Ache.dc.html`, in the handoff
bundle) into a fully functional desktop SSH client. Build phase by phase —
do **not** land it all at once.

Legend: ☐ todo · ◑ partial · ☑ done

---

## Phase 0 — Design → UI (frontend shell)   ☑
Port the design 1:1 into the app as a React component. Every **frontend-only**
interaction is live; anything needing the OS or a real socket is demo-only for
now and gets wired in later phases.

- ☑ Add React + `@vitejs/plugin-react`; mount in `src/main.tsx`.
- ☑ `src/App.tsx` — full design port (title bar, sidebar, dashboard, terminal
  workspace, command palette, themes browser, add/edit host, settings, toasts,
  status bar).
- ☑ Dashboard: folder filter, tag filter, text search, grouped cards, empty state.
- ☑ Add / Edit / Delete host (in-memory **+ localStorage** persistence).
- ☑ Command palette (⌘K), themes browser (⌘T), settings, shortcuts
  (⌘B/⌘D/⌘J/⌘N/⌘1/⌘2, Esc).
- ☑ Tabs + split panes (row/col) + drag-resizable gutters.
- ☑ Private-key paste validation (PEM / OpenSSH / cert sanity checks).

**Demo-only after Phase 0** (wired later): terminal I/O is a fake shell,
connect animation, SFTP transfers, theme→terminal colours, window controls.
*(Terminal I/O + connect are now real as of Phase 1.)*

---

## Phase 1 — Real terminal + SSH   ◑  (done; runs in the Tauri app)
Panes run real shells over the russh backend.

- ☑ Multi-session backend: `SshState` is now `Mutex<HashMap<String, Sender>>`;
  every `ssh_*` command takes a `sessionId` (`src-tauri/src/main.rs`).
- ☑ `TermPane` (`src/App.tsx`): a real xterm.js terminal per live pane, created
  once, wired `onData`→`term.write`, `term.onData`→`ssh_write`,
  `ResizeObserver`→`ssh_resize`; disposed + `ssh_disconnect` on unmount. Theme +
  font-size apply live.
- ☑ `connectHost` → real flow: gather the secret (per-connect prompt), open a
  live tab, connect. Success / failure reported back to the connect overlay + a
  toast; a host-key-changed error shows the MITM warning in the terminal.
- ☑ Secrets: per-connect password / passphrase prompt; agent needs none. Never
  persisted — held in memory on the tab only.
- ☑ Split on a live pane opens a second independent shell to the same host.

Residual / later:
- Connect-overlay steps (resolve/handshake/auth/shell) are cosmetic — wire to
  real handshake milestones if wanted.
- ☑ "New tab" / "+" now opens a **real local shell** (PTY via `portable-pty`:
  `pty_spawn/write/resize/close`); the seed tab stays as a static welcome.
- Pane-header `cwd` is a static `~` (track the real shell cwd later).
- Verifiable only inside `npm run tauri dev`; the browser preview shows a hint.

---

## Phase 2 — Host store & secrets   ◑  (done; full path runs in the Tauri app)
- ☑ Host profiles persisted to `~/.ssh-ache/state.json` via Tauri
  (`read_config` / `write_config`, std::fs, dir chmod 0700). localStorage is the
  browser-preview fallback **and** a one-time migration source. Non-secret
  fields only.
- ☑ Secrets in the OS keychain via `keyring` (`secret_get/set/delete`, service
  `sshache`, key = host id). The Add/Edit form's password / passphrase / pasted
  key are saved there on save; `connectHost` uses a remembered secret and skips
  the prompt, otherwise prompts per-connect; delete-host clears the entry.

Residual / later:
- `keyring` is macOS-only for now (`apple-native`); add `windows-native` /
  `sync-secret-service` features for those platforms.
- ☑ Settings → Import / Export: now a password-encrypted backup — see
  "Encrypted backup" at the bottom.
- ☑ Pasted key text now connects: `do_auth` decodes it from memory
  (`decode_secret_key`) — never written to disk. (SFTP still uses key files only.)
- ☑ "Lock vault after idle" is real: set a vault passphrase (PBKDF2 hash stored
  in `state.json`); 15 min idle → full-screen lock; unlock with the passphrase.
  "Lock now" in the palette locks on demand.

---

## Phase 3 — Host-key verification UX   ◑  (done; runs in the Tauri app)
- ☑ First-seen keys are no longer auto-trusted. `check_server_key` records the
  SHA256 fingerprint + key and rejects the handshake; `ssh_connect` returns a
  structured `UNKNOWN_HOST` error; the UI shows a confirm modal with the
  fingerprint. Accept → `trust_host` writes `~/.ssh/known_hosts` → auto-reconnect.
  Reject → cancel.
- ☑ Changed key → structured `KEY_CHANGED` error (no longer regex-sniffed); the
  terminal shows the MITM warning and the connection is refused.

Residual / later:
- The confirm dialog can't be exercised in the browser preview (needs a real
  handshake); verified by compile + the connect flow.

---

## Phase 4 — SFTP   ◑  (done; runs in the Tauri app)
- ☑ `russh-sftp` backend: `sftp_connect` (its own SSH connection per panel via
  the shared `do_auth`), `sftp_list`, `sftp_get`, `sftp_put` (chunked, real %
  progress over a `Channel`), `sftp_disconnect`; plus `local_list` / `local_home`.
- ☑ Panel wired: opens on ⌘J / the SFTP button against the active live session,
  lists local home + remote home; drag a file across to upload / download with a
  live progress bar; refreshes the destination on completion.

Residual / later:
- ☑ Directory navigation: click a folder to enter it, `..` to go up (both panes).
- SFTP opens its own SSH connection; reuse the terminal's session later.
- mkdir / delete / rename not implemented (not in the design).
- Verified by compile + the not-ready path in the browser; real listing /
  transfer needs `npm run tauri dev`.

---

## Phase 5 — Themes, settings, terminal prefs   ◑  (done)
- ☑ Active theme drives the terminal: `xtermTheme()` maps bg/fg/cursor + an
  accent-tinted ANSI palette, applied on mount and live on change. The fake
  shell and the live xterm both recolour; app chrome stays the SSH Ache brand
  orange (the community themes are *terminal* themes). `themeId` persists.
- ☑ Settings apply live to xterm: font size, cursor style (block/bar/underline),
  scrollback — on mount and on change.
- ☑ Settings persist via `state.json` (the Phase-2 store); the Settings modal
  label now reads `state.json` instead of the placeholder `config.toml`.

Residual / later:
- ☑ Per-theme full ANSI palettes: each theme now ships a canonical 16-colour
  ANSI set (`ansi[]`), applied to xterm (`xtermTheme`).

---

## Phase 6 — Window chrome   ◑  (done; runs in the Tauri app)
- ☑ `"decorations": false` — the design title bar is the window chrome.
- ☑ Title bar + its spacer carry `data-tauri-drag-region` (drag to move);
  capabilities grant `core:window:allow-start-dragging` / `-minimize` /
  `-toggle-maximize` / `-close`.
- ☑ Min / maximise / close glyphs wired to `getCurrentWindow()` (with hover —
  red on close).

Residual / later:
- Verified by compile (config + capabilities pass `generate_context!`) + render;
  drag / min / max / close need `npm run tauri dev`.
- No custom resize handles — relies on Tauri's borderless-resize default.

---

## Phase 7 — Polish / offline   ☑
- ☑ JetBrains Mono vendored via `@fontsource/jetbrains-mono` (imported in
  `main.tsx`, bundled by Vite); the Google Fonts CDN `<link>` is gone — no
  third-party request, fully offline.
- ☑ Confirm-before-close: closing a *live* tab with the toggle on shows a
  "Close session?" modal; internal/programmatic closes bypass it (`force`).
- ☑ Restore-tabs-on-launch: open live hosts persist (`openHosts` in state.json);
  on launch those with a remembered secret (or agent auth) silently reconnect,
  and any that would need a prompt are skipped.
- ☑ Command-palette actions already call the real methods (connect / split /
  sftp / theme / settings) — audited, no change needed.

---

## Encrypted backup (import / export)
Settings → Export / Import. **Export** bundles hosts + settings + theme + the
keychain secrets, encrypts the JSON with the user's password (Web Crypto:
PBKDF2-SHA256 ×200k → AES-256-GCM) and writes it to a file chosen via a native
save dialog. **Import** picks a file, prompts for the password, decrypts,
restores hosts/settings and writes the secrets back to the keychain. Wrong
password → AES-GCM auth failure → "Import failed". Backend: `write_file` /
`read_file` (arbitrary path) + `tauri-plugin-dialog`; capabilities add
`dialog:allow-save` / `dialog:allow-open`. Verified: crypto round-trip +
wrong-password rejection in the webview; the native dialogs run in
`npm run tauri dev`.

## Local port forwarding (-L)
Command palette → "Add port forward" (against the active SSH session) → a dialog
for local-port → remote-host:remote-port. Backend `forward_start` opens its own
SSH connection, binds `127.0.0.1:<local>`, and bridges each accepted socket to
`remote_host:remote_port` via a `direct-tcpip` channel
(`tokio::io::copy_bidirectional`); `forward_stop` aborts the listener task.
Active forwards show in the status bar (`⇄ N fwd`) and stop when the session tab
closes or via "Stop port forwards". Verified by compile + palette wiring; live
tunnels run in `npm run tauri dev`.

## ProxyJump (bastion) + ~/.ssh/config import + broadcast input
Three follow-on features, all behind the existing connect/host plumbing.

- **ProxyJump** — a host can pick another saved host as its **Jump host** (Add/Edit
  form). `ssh_connect` takes an optional `jump`; `open_session` brings up the jump
  host on its own handler (its key is verified too — unknown/changed jump key is
  *refused*, not auto-trusted), opens a `direct-tcpip` channel to the target, and
  runs the target session over it via `client::connect_stream`. The jump handle is
  kept alive alongside the target in the IO task. Target key errors keep the same
  `UNKNOWN_HOST` / `KEY_CHANGED` structured form, so the existing confirm modal
  still works. One hop only (the jump host's own jumpHost is ignored). SFTP /
  forwards still connect directly — wire jump there later if wanted.
- **Import ~/.ssh/config** — palette → "Import from ~/.ssh/config". Backend
  `read_ssh_config` returns the file; `parseSshConfig` (in `App.tsx`) maps Host
  blocks → hosts (skips wildcard patterns), defaults auth to `key` when an
  IdentityFile is set else `agent`, dedups by `user@addr:port`, and links
  `ProxyJump` to a matching host by alias/name. Imported hosts land in an
  "Imported" folder, tagged `ssh-config`.
- **Broadcast input** — palette → "Broadcast input to all panes" (status-bar badge
  while on). When on, a keystroke in any pane of the active tab is fanned to every
  live pane in that tab (cluster-ssh) via `broadcastInput`. Scoped to the active
  tab; click the badge to turn off.

Verified: `cargo check` + `npm run build` pass; the parser has a self-check
(wildcard skip + ProxyJump alias resolution). Live tunnel / fan-out need
`npm run tauri dev`.

## Follow-on batch — secrets, keepalive, search, snippets, SFTP ops, -D/-R, cwd
All additive; the working paths above are untouched.

- **Per-OS keyring** — `Cargo.toml` now picks the native keychain backend per
  platform (`apple-native` / `windows-native` / `sync-secret-service`). The
  0600 `secrets.json` is still the primary store, so this just restores the
  best-effort OS-keychain mirror on Windows/Linux.
- **Keepalive** — `ssh_config()` sets `keepalive_interval: 30s`, `keepalive_max: 3`
  on every connection, so NAT/firewall idle-timeouts stop killing live tunnels &
  terminals. A session that drops anyway (idle timeout, network loss, sshd
  restart) is no longer silent: the pane stays put and a **Connection lost**
  modal offers *Reconnect* (same host, fresh shell, same pane — tab, layout and
  scrollback all survive) or *Close tab*. `TermPane` only reports a close while
  it is still mounted, so an intentional teardown never raises the prompt, and
  simultaneous drops queue rather than overwrite each other.
- **Scrollback search (⌘F)** — `@xterm/addon-search` + an in-pane find bar
  (Enter / ⇧Enter / Esc). `attachCustomKeyEventHandler` swallows ⌘F so the shell
  never sees it.
- **On-connect command** — host form field `snippet`; `TermPane` writes it once
  after the shell opens.
- **SFTP create-folder / rename / delete** — backend `sftp_mkdir` / `sftp_rename`
  / `sftp_remove` (recursive for dirs); remote-panel header buttons + a small
  prompt/confirm modal.
- **Dynamic SOCKS (-D)** — `socks_start` runs a minimal SOCKS5 server
  (CONNECT, no auth) bridging each target over a `direct-tcpip` channel.
- **Remote forward (-R)** — `remote_forward_start` calls `tcpip_forward`; the
  `Handler` gained a `remote: Option<(host, port)>` and a
  `server_channel_open_forwarded_tcpip` impl that bridges forwarded channels to
  the local target. Both reuse `ForwardState`/`forward_stop` and a shared
  3-mode forward dialog/palette.
- **Live cwd (OSC 7)** — `TermPane` registers an OSC-7 handler → `setPaneCwd`
  updates the pane header; shells that don't emit it keep the static `~`.

Verified: `cargo check` + `npm run build` pass; landing page rendered & all 13
feature cards confirmed in the DOM. SOCKS/-R/SFTP live paths need
`npm run tauri dev`.

## Output triggers
Settings → Output triggers: add a regex; matching output lines get a coloured
gutter marker and/or an in-app notification. `TermPane` scans the output channel
(both SSH and local PTY) with a rolling line buffer + ANSI strip, tests each
completed line against the compiled regexes (cached, case-insensitive), and on a
match registers an xterm decoration and/or calls back to a throttled toast (one
per trigger per 4s). Triggers live in the persisted `settings.triggers` array.
ponytail: the highlight marker sits at the cursor line, so on a multi-line write
it can land a row below the match — the toast carries the exact line. Desktop
(OS-level) notifications are a later add; in-app toast for now. Verified:
`npm run build` + a node self-check (ANSI strip, cross-chunk match, partial-hold,
CRLF) + the Settings UI exercised in the browser preview (add / toggle / remove).

## Notes
- `src/App.tsx` is `@ts-nocheck` — a faithful port of the untyped prototype.
  Type it incrementally as each phase replaces demo logic with real calls.
- The old minimal UI (`src/main.ts`, removed) used the russh backend directly;
  that backend is unchanged and ready to wire in Phase 1.
- Source of truth for the design: the handoff bundle in the repo root.
