<p align="center"><img src="src/assets/logo-wordmark.svg" width="420" alt="SSH Ache"></p>

<p align="center">A desktop SSH client with a clean terminal UI — connections, SFTP, port forwarding, and an approval-gated AI agent bridge, with your data kept on your machine and anything you share with a team end-to-end encrypted.</p>

<p align="center">
  <a href="https://github.com/SSH-Ache/ssh-ache-teams/releases"><img src="https://img.shields.io/github/v/release/SSH-Ache/ssh-ache-teams?color=ff5f6d&label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-ff7a59" alt="Platforms: macOS, Windows, Linux">
  <img src="https://img.shields.io/badge/built%20with-Tauri%202-ff8a63" alt="Built with Tauri 2">
  <a href="https://github.com/SSH-Ache/ssh-ache-teams/releases"><img src="https://img.shields.io/github/downloads/SSH-Ache/ssh-ache-teams/total?color=46d9a0&label=downloads" alt="Total downloads"></a>
</p>

<p align="center">
  <a href="https://sshache.com">Website</a> ·
  <a href="https://sshache.com/docs">Docs</a> ·
  <a href="https://github.com/SSH-Ache/ssh-ache-teams/releases">Releases</a> ·
  <a href="https://github.com/SSH-Ache/ssh-ache-teams/issues/new">Report a bug</a>
</p>

> "Don't be so busy making a living that you forget to actually make a life."

<p align="center"><img src="docs/screenshot.png" width="820" alt="The SSH Ache Teams dashboard: personal connections in folders alongside a shared team folder, with a saved four-pane team workspace"></p>

## Features

- 💻 **Real terminal** — full SSH sessions (russh + xterm.js), tabbed, with splittable panes, plus local shell tabs.
- 🗂️ **Host vault** — saved hosts organised in folders with colours and favourites; secrets stored outside the config in a `0600` file (see [Security](#security)); copy a ready-to-run `ssh` command for any host.
- 🔐 **Host-key verification** — first-connect fingerprint confirmation, `known_hosts` tracking, and a hard refusal with a warning if a host key ever changes (MITM protection).
- 📁 **SFTP browser** — dual-pane local/remote navigation with drag-and-drop transfer of multiple files and whole folders, a replace/skip conflict prompt, and remote create-folder / rename / delete.
- 🔀 **Port forwarding & SOCKS** — local (`-L`), remote (`-R`), and a dynamic SOCKS5 proxy (`-D`), all over the SSH connection. Keepalive keeps idle tunnels alive.
- 🛫 **Jump hosts (ProxyJump)** — reach a host through a saved bastion; the jump host's key is verified too.
- 📥 **Import `~/.ssh/config`** — pull existing hosts (and their ProxyJump links) straight into the vault.
- 🔄 **Reconnect on drop** — when a session times out or the network goes, the pane stays where it is and a **Connection lost** prompt offers *Reconnect* (same host, fresh shell, tab and scrollback intact) or *Close tab*.
- 📡 **Broadcast input** — type once, send to every split pane in a tab (cluster-ssh).
- 🔎 **Find & on-connect commands** — `⌘F` searches the terminal scrollback; each host can run a saved command (e.g. `tmux attach`) the moment the shell opens.
- 🎨 **Themes & settings** — community terminal themes with live font size, cursor, and scrollback controls.
- 💾 **Encrypted backup** — export and import your hosts and secrets as a password-encrypted file (PBKDF2 → AES-256-GCM).
- ⏳ **Idle screen lock** — optional passphrase lock on the window after a period of inactivity (sessions and forwards keep running behind it).
- 🤖 **AI agent access (MCP)** — an optional, off-by-default MCP server bound to localhost behind a bearer token, with per-host opt-in and per-command in-app approval — plus an opt-in per-host Auto-allow that skips the prompt. See [docs/MCP.md](./docs/MCP.md).
- 🖥️ **Cross-platform** — built with Tauri 2 (Rust) for macOS, Windows, and Linux.

## Install

### Homebrew (macOS)

```sh
brew install --cask SSH-Ache/sshache/sshache-teams
```

### Direct download

Grab the latest platform build — `.dmg` (macOS), `.msi` (Windows), or `.AppImage` / `.deb` (Linux) — from the [Releases](https://github.com/SSH-Ache/ssh-ache-teams/releases) page.

### Build from source

```sh
npm install
npm run tauri build
```

Building from source requires Rust and the Tauri toolchain. See the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for platform-specific setup.

## Security

- **Host-key verification** — fingerprints are confirmed on first connect and tracked in `known_hosts`; if a host key ever changes, the connection is refused with a warning to guard against man-in-the-middle attacks. There is no "connect anyway" button.
- **Jump hosts are verified too** — a bastion's key is checked before any credential is sent to it.
- **End-to-end encrypted sharing** — connections shared with a team are sealed on your device under a team key that the server never sees in the clear. The full design, including what the server stores and what happens when a member is removed, is published at [sshache.com/docs/security](https://sshache.com/docs/security.html).
- **Encrypted backups** — exported hosts and secrets are sealed with PBKDF2-SHA256 (600k iterations) and AES-256-GCM. Exporting a single connection or a workspace *without* a password leaves the secrets out of the file entirely.
- **Approval-gated AI access** — the MCP server is off by default, bound to `127.0.0.1` behind a random bearer token, and default-deny per host. Every command needs explicit in-app approval unless you turn on **Auto-allow** for a specific host, which is off by default and skips the prompt for that host only. Secrets are never exposed to the agent. Details in [docs/MCP.md](./docs/MCP.md).

### Where local secrets are stored

Passwords, key passphrases, pasted private keys and your Teams session are written to `~/.ssh-ache/secrets.json`, a file created with mode `0600` (owner read/write only) — the same access posture as `~/.ssh/id_rsa`. **They are not encrypted at rest.** They are mirrored to the OS keychain where that works, and the keychain is read as a fallback, but the file is the primary store: keychain access is tied to an app's code signature and is unreliable on unsigned builds.

Practically: anything running as your user can read those secrets, exactly as it can read your `~/.ssh` private keys. Full-disk encryption (FileVault / BitLocker / LUKS) is what protects them at rest. This is separate from team sharing — what leaves your machine for the server is always ciphertext.

## Tech stack

Tauri 2 (Rust backend) · React + xterm.js (frontend) · russh / russh-sftp · portable-pty · @noble/* (E2EE) · keyring (OS keychain mirror).

## License

**Dual-licensed** — see [LICENSING.md](./LICENSING.md) for the full picture.

- **Noncommercial use is free**, under the [PolyForm Noncommercial License 1.0.0](./LICENSE): personal use, research, education, hobby projects. Read it, build it, modify it, self-host it.
- **Commercial use requires a separate paid commercial license** — using it at work, inside a company, or to deliver a paid product or service. Email [hello@sshache.com](mailto:hello@sshache.com).

Want a permissively licensed build you can use commercially with no permission at all? That's the **[community edition](https://github.com/SSH-Ache/ssh-ache)** — Apache-2.0, individual use, no team or server code.

## Support

Paid plans include support — email [hello@sshache.com](mailto:hello@sshache.com), or open an
issue in this repo. Manage your plan and invoices at [sshache.com/app](https://sshache.com/app).

## Author

**Noor Ajmir Tanvir**

- Website — [tanvirmahin.com](https://tanvirmahin.com)
- GitHub — [@TanvirMahin24](https://github.com/TanvirMahin24)
- Email — [tanvirmahin24@gmail.com](mailto:tanvirmahin24@gmail.com)
