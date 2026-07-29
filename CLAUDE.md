# SSH Ache — Teams (full desktop app)

The full SSH Ache desktop client: the local features of the community edition **plus Teams** —
end-to-end-encrypted sharing of SSH connections via the sshache backend. Source-available under
**PolyForm Noncommercial**. This is the app that is actually released/distributed.

Everything in the community `ssh-ache` guide applies (same Tauri/React/Rust stack + commands;
`src/App.tsx` is `// @ts-nocheck`, so **verify with `npm run build`**, not tsc). Additions below.

## Teams module (`src/teams/`)
- `client.ts` — talks to the SaaS backend. **Base URL is hard-wired to `https://sshache.com`**
  (the `base` const); the app never lets the user type a backend URL. Bearer-token auth,
  refresh-on-401.
- `TeamsPanel.tsx` — the Teams tab (sign in / device-link, teams, members, invites, sync).
- **Session persistence** — the app stays signed in across launches: `client.ts` keeps the 64-byte
  identity secret + the rotating refresh token in the **OS keychain** (`secret_set` id
  `teams.session`), restores it via `restoreSession()` from `componentDidMount`, and re-saves on
  every token refresh. Signing out (sidebar account row or the Teams tab) wipes that entry.
- `crypto/` — the E2EE layer (X25519/Ed25519 identities, Team Key sealed to each member,
  per-connection DEK; `@noble/*`). **The wire format is frozen and shared with the platform web
  client — do not change it casually** (guarded by known-answer tests).
- Woven into `src/App.tsx`: the Teams tab, device linking, live presence, spectate/mirror (watch a
  teammate's session through the relay), auto-sync of shared connections.

## Team workspaces
Workspaces (saved multi-connection tabs — see the community guide for the model) can be **shared**
here. When a workspace is built on team connections, the save modal asks: *Team workspace* or *Just
for me* (the latter files it under `Others`, nothing uploaded).
- Sharing (`_shareWorkspace`) first uploads any member connection that isn't shared yet
  (`shareHostToTeam`), so teammates can actually connect, then stores the **arrangement itself as a
  team connection record** whose sealed meta carries `kind: 'workspace'` + `workspace.slots` keyed
  by cloud `connId`. `syncTeam` routes `meta.kind === 'workspace'` to `_upsertTeamWorkspace`
  instead of `_upsertTeamHost`, and prunes both.
- ⚠️ The meta is only ever ciphertext to the server, but the **platform web client will decrypt and
  list a workspace record as if it were a connection** until it learns about `kind: 'workspace'`.
  That is the one place this feature reaches outside the desktop app — teach the web client to skip
  or render these before promoting it.
- Deleting a shared workspace locally is not a team delete: it returns on the next sync (there is no
  `deleteConnection` in `client.ts` yet). The toast says so.

## Key invariant
Zero-knowledge: the server only ever receives ciphertext + wrapped keys. **Never send a plaintext
SSH secret or hostname to the backend.** The single designed exception is the relay
web-terminal/mirror (terminal *output* only — never keystrokes or secrets).

## Relationship to `ssh-ache` (community)
The public community repo is THIS repo with all `src/teams/` + backend integration stripped and
relicensed Apache-2.0. Change a **local** feature → it should be portable to community. Change a
**teams** feature → it stays here only. Keep local vs teams cleanly separable.

## CI / release
`ci.yml` (Vite build) + `release.yml` (tag → installers), plus `homebrew.yml` (needs a tap +
`HOMEBREW_TAP_TOKEN`). Version tags `v0.1.0`–`v0.8.0` are preserved. See the `cut-release` skill.

⚠️ **This repo must stay PUBLIC.** While it was private its release assets 404'd for
unauthenticated clients, which silently broke three things: the Homebrew cask (the workflow hashed
the 9-byte `Not Found` body, shipping `sha256("Not Found")` in v0.7.5 and v0.8.0), the in-app
update check (`UPDATE_REPO` in `src/App.tsx`), and every download link on the website. If it is
ever made private again, all three break again. `homebrew.yml` now fails loudly rather than
publishing a cask for an unfetchable URL.

## Licence
Dual-licensed — see `LICENSING.md`. Public source under PolyForm Noncommercial (free for
noncommercial use); **commercial use needs a separate paid licence**. Don't describe it as "open
source" or imply free commercial use — the Apache-2.0 community edition is the permissive one.
