# MCP server (AI agent access)

SSH Ache can expose an MCP server so an AI agent can use your saved hosts —
**off by default, localhost-only, opt-in per host, and approval-gated per
command** (unless you opt a host into [Auto-allow](#auto-allow-opt-in-off-by-default)).

## Enable
Settings → **AI agent access** → **Manage** → **Start**. Toggle on the hosts the
agent may use (none by default). The page shows the URL, bearer token, and a
ready-to-paste client config.

## Connect an MCP client
The server speaks MCP over HTTP (JSON-RPC) at `http://127.0.0.1:8765/mcp` with an
`Authorization: Bearer <token>` header:

```json
{
  "mcpServers": {
    "sshache": {
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## Tools
- `list_hosts` — exposed hosts (id, name, target, tags). No secrets, no approval.
- `run_command(host_id, command)` — runs a command over SSH and returns its
  output. **Every call pops an approval dialog in the app** — showing the command
  and the real target (`name · user@addr:port`, not just the label you gave the
  host) — unless that host has Auto-allow on. Deny or a 2-minute timeout =
  refused. Hosts that connect through a jump host are refused: the bridge does
  not support ProxyJump yet.

## Auto-allow (opt-in, off by default)
Each exposed host has a second toggle, **AUTO**, that skips the approval dialog
for that host: the agent runs commands on it unattended. It is off by default,
per host, and only settable in the app — imported connection files cannot turn it
on, and turning off a host's agent access clears it. Auto-allowed runs are still
written to the audit log, tagged `AUTO`.

**This is the guardrail described below, switched off.** Turn it on only for a
host where an agent running an arbitrary command — including one that arrived as
prompt injection in some earlier command's output — is an acceptable outcome. A
scratch VM, not your production database.

## Security model
- **Off by default**; bound to `127.0.0.1` behind a random bearer token. An empty
  token authenticates nothing.
- **Default-deny**: only hosts you toggle on are visible to the agent.
- **Human-in-the-loop**: each command needs your explicit in-app approval, unless
  you enabled Auto-allow for that host.
- **No secret exposure**: passwords / keys stay in the local store — the agent
  never sees them (the app uses them internally to run the approved command).
- **Audit log** of approved / denied / auto-allowed commands on the Manage page.

Why this matters: handing an AI agent raw SSH is the worst case for prompt
injection (remote output can carry instructions → destructive commands / lateral
movement). Per-command approval is the backstop; without it — i.e. with
Auto-allow on — exposing arbitrary SSH exec to an agent is not safe, and you are
trusting the agent and everything that reaches its context.

## Implementation
- Backend: `mcp_start` / `mcp_stop` / `mcp_status` / `mcp_approval_respond` + a
  `tiny_http` JSON-RPC server (`initialize` / `tools/list` / `tools/call`) in
  `src-tauri/src/main.rs`. Approval = a Tauri event to the GUI + a oneshot the
  command awaits.
- Frontend: the Manage page + the per-command approval modal in `src/App.tsx`.

## Residual / harden later
- Per-command allowlists / regex policy per host — the middle ground between
  approving everything by hand and Auto-allow.
- Jump-host (ProxyJump) support for agent commands.
- Read-only SFTP tools (`read_file`, `list_dir`) as lower-risk alternatives.
- Rate limiting; fixed-port (8765) conflict handling; optional stdio transport.
- Persist the token in the keychain rather than `state.json`.
