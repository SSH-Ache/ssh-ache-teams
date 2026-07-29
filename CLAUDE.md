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
- `crypto/` — the E2EE layer (X25519/Ed25519 identities, Team Key sealed to each member,
  per-connection DEK; `@noble/*`). **The wire format is frozen and shared with the platform web
  client — do not change it casually** (guarded by known-answer tests).
- Woven into `src/App.tsx`: the Teams tab, device linking, live presence, spectate/mirror (watch a
  teammate's session through the relay), auto-sync of shared connections.

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
