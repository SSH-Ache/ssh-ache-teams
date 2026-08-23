# Security policy

## Reporting a vulnerability

Email **security@sshache.com**, or open a
[private security advisory](https://github.com/SSH-Ache/ssh-ache-teams/security/advisories/new)
on GitHub. Please do not open a public issue for a vulnerability.

Include what you did, what happened, and the version (`Settings → About`). A proof of
concept helps but is not required. Expect an acknowledgement within 72 hours and, if the
report is valid, a fix or a plan with a date. You will be credited in the release notes
unless you would rather not be.

## Supported versions

The latest release. There are no backports.

## What is and isn't in scope

The interesting surface is: the end-to-end encryption layer (`src/teams/crypto/`) and its wire
format, the Teams sync/session handling in `src/teams/client.ts`, host-key verification, the
local credential store, the MCP agent bridge, port forwarding, SFTP path handling, and the
encrypted export format. The server side lives in a separate repository; report issues there to
the same address.

Known and deliberate, so not vulnerabilities on their own:

- **Local secrets are not encrypted at rest.** `~/.ssh-ache/secrets.json` is a `0600` file — the
  same posture as `~/.ssh/id_rsa` — and it holds SSH credentials plus the Teams session blob.
  Anything running as your user can read it. See
  [Where local secrets are stored](./README.md#where-local-secrets-are-stored).
- **The idle lock is a screen lock.** It does not re-encrypt anything, and sessions, forwards and
  the MCP server keep running behind it.
- **Auto-allow, when you turn it on**, lets an agent run commands on that host without a prompt.
  That is the documented purpose of the toggle — see [docs/MCP.md](./docs/MCP.md).
- **A removed member can still hold what they already decrypted.** Removal deletes their wrapped
  team key and rotates the key, so nothing sealed afterwards opens for them; it cannot un-see
  earlier plaintext. Rotate credentials on hosts a departing member could reach.
- **Live view mirrors terminal output** to the relay by design (never keystrokes or secrets).
- **macOS builds are unsigned and un-notarised** today.

In scope and taken seriously: anything that would let the server, the relay, or a non-member read
plaintext; a build or code path that wraps a key to an unintended recipient; agent access being
granted without an explicit in-app action.

## Known dependency advisories

`npm audit` is clean. `cargo audit` reports one advisory with no upstream fix:

- **[RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071)** — Marvin attack
  (timing sidechannel) in the `rsa` crate, pulled in transitively by `russh`. No fixed version
  exists. It affects RSA private-key operations, i.e. publickey auth with an RSA key, and needs
  fine-grained timing measurements of that key's operations. Using an Ed25519 key avoids the
  code path entirely. Every Rust SSH client currently carries this.

The rest of what `cargo audit` prints is unmaintained-crate warnings for tauri's Linux GTK3
bindings, which are not fixable from here.
