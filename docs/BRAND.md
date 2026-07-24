# SSH Ache — brand spec

Single source of truth for logo, colours, copy, and links. Used by the app,
the README, and the sshache.com site so everything stays consistent.

## Name & identity
- **Product:** SSH Ache (one space, both words capitalised). Package id: `sshache`.
- **Domain / landing:** https://sshache.com
- **Repo:** https://github.com/SSH-Ache/ssh-ache-teams
- **Releases:** https://github.com/SSH-Ache/ssh-ache-teams/releases
- **Author:** Noor Ajmir Tanvir — https://tanvirmahin.com · https://github.com/TanvirMahin24 · tanvirmahin24@gmail.com
- **Support / tip:** https://www.patreon.com/cw/tanvirmahin24  (button label: "Buy me a coffee ☕")
- **Motto (use prominently):** “Don't be so busy making a living that you forget to actually make a life.”

## Forbidden copy (do NOT use these phrases anywhere)
`local-first`, `no telemetry`, `no account`, `account required`, `open source`, `MIT`, `MIT license`.
You may still say things like “your data stays on your machine, encrypted at rest” — just not the exact phrases above.

## Logo assets
- Mark (square / favicon / avatar): `src/assets/logo-mark.svg`
- Wordmark (banners / site header): `src/assets/logo-wordmark.svg`
The mark is a gradient app-tile with a cream heart and an embossed ECG/heartbeat
pulse — the heartbeat ties to the name (“ache”) and the life motto. For a
self-contained site, copy these SVGs into the site's own assets folder.

## Colour tokens
- App bg: `#0a0a0d`; panels: `#0c0c10`, `#0e0e12`; cards: `#101015`
- Borders: `#1c1c24`, `#20202a`, `#26262e`
- Text: `#ededf0` (strong), `#9a9aa3` (muted), `#6a6a74` (dim), `#54545e` (faint)
- Brand gradient: `#ff8a63 → #ff5f6d → #ff3d7f` (use for accents, CTAs, headings)
- Brand solid: `#ff7a59` (primary), `#ff8d70` (hover), accent ink on brand: `#0c0b0a`
- Status green: `#46d9a0`
- Font (everything): `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`
- Vibe: dark, terminal, premium, lots of breathing room, subtle glows
  (`box-shadow: 0 0 24px rgba(255,122,89,.4)`), rounded corners (7–14px).

## What SSH Ache is (one-liner)
A desktop SSH client with a clean terminal UI — connections, SFTP, port
forwarding, and an approval-gated AI agent bridge, with your data kept on your
machine and encrypted at rest.

## Feature list (for marketing copy)
- **Real terminal** — full SSH sessions (russh + xterm.js), tabbed, splittable panes, plus local shell tabs.
- **Host vault** — saved hosts in folders with colours & favourites; secrets stored in the OS keychain; copy a ready `ssh` command per host.
- **Host-key verification** — first-connect fingerprint confirmation, `known_hosts`, and a hard refusal with a warning if a host key ever changes (MITM protection).
- **SFTP browser** — dual-pane local/remote navigation, drag-and-drop transfer of multiple files and whole folders, with a replace/skip conflict prompt.
- **Port forwarding** — local forwards bridged over the SSH connection.
- **Themes & settings** — community terminal themes, live font size / cursor / scrollback.
- **Encrypted backup** — export/import your hosts and secrets to a password-encrypted file (PBKDF2 → AES-256-GCM).
- **Idle vault lock** — optional passphrase lock after inactivity.
- **AI agent access (MCP)** — an optional, off-by-default MCP server bound to localhost behind a bearer token; per-host opt-in and per-command in-app approval; secrets never reach the agent.
- **Cross-platform** — built with Tauri 2 (Rust); macOS, Windows, Linux.

## Install (for docs)
- **Homebrew (macOS):** `brew install --cask SSH-Ache/sshache/sshache`
- **Direct download:** platform builds (.dmg / .msi / .AppImage / .deb) from GitHub Releases.
- **From source:** `npm install && npm run tauri build` (needs Rust + the Tauri prereqs).

## Tech stack
Tauri 2 (Rust backend) · React + xterm.js (frontend) · russh / russh-sftp · portable-pty · OS keychain (keyring).
