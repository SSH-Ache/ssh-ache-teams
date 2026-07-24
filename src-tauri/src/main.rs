#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use russh::client;
use russh::client::{AuthResult, KeyboardInteractiveAuthResponse};
use russh::keys::ssh_key::PublicKey;
#[cfg(unix)]
use russh::keys::agent::client::AgentClient;
#[cfg(unix)]
use russh::keys::agent::AgentIdentity;
use russh::keys::known_hosts::{check_known_hosts, learn_known_hosts};
use russh::keys::{decode_secret_key, load_secret_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

enum KeyIssue {
    Unknown(String, String), // (fingerprint, openssh public key)
    Changed,
}

struct Handler {
    host: String,
    port: u16,
    // Set by check_server_key when the presented key is unknown or changed, so
    // ssh_connect can surface it to the UI instead of silently trusting it.
    issue: Arc<Mutex<Option<KeyIssue>>>,
    // For remote forward (-R): the local target each server-initiated forwarded
    // channel is bridged to. None for every other connection.
    remote: Option<(String, u16)>,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    // Remote forward (-R): the server accepted a connection on the forwarded
    // port and opened this channel to us — bridge it to the local target.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if let Some((lhost, lport)) = self.remote.clone() {
            tokio::spawn(async move {
                if let Ok(mut local) = tokio::net::TcpStream::connect((lhost.as_str(), lport)).await {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut local, &mut stream).await;
                }
            });
        }
        Ok(())
    }

    // Trust-on-first-use with an interactive confirm (Phase 3):
    //   known host, key matches -> Ok(true)
    //   unknown host            -> record fingerprint + reject; the UI confirms,
    //                              then `trust_host` learns it and we reconnect
    //   known host, key CHANGED -> record + abort (possible MITM)
    // The mismatch MUST stay a rejection — that is the entire MITM protection.
    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        match check_known_hosts(&self.host, self.port, key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                let fp = key.fingerprint(russh::keys::ssh_key::HashAlg::Sha256).to_string();
                let openssh = key.to_openssh().unwrap_or_default();
                *self.issue.lock().unwrap() = Some(KeyIssue::Unknown(fp, openssh));
                Ok(false)
            }
            Err(e) => {
                *self.issue.lock().unwrap() = Some(KeyIssue::Changed);
                Err(e.into())
            }
        }
    }
}

enum SshCmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

// One live PTY session per id (= a UI pane). ponytail: a dead session's Sender
// lingers in the map until ssh_disconnect / a reconnect with the same id — the
// IO task can't reach the state to evict itself; harmless, the frontend cleans
// up on pane unmount.
#[derive(Default)]
struct SshState(Mutex<HashMap<String, UnboundedSender<SshCmd>>>);

#[derive(serde::Serialize)]
struct FileEntry {
    name: String,
    kind: String, // "dir" | "file"
    size: String,
}

// One dedicated SFTP connection per UI panel, keyed by id (= tab id + ":sftp").
// ponytail: opens its own SSH connection instead of sharing the terminal's
// russh Handle across the IO task — simpler; reuse the session later if the
// extra connection ever matters.
#[derive(Default)]
// Value: (sftp session, target handle, optional jump handle). The handles are
// kept only to stay alive — drop the jump handle and its tunnel closes.
struct SftpState(Mutex<HashMap<String, (Arc<SftpSession>, client::Handle<Handler>, Option<client::Handle<Handler>>)>>);

// Local shell (Phase: "New tab") — a real PTY per local tab.
struct PtySlot {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}
#[derive(Default)]
struct PtyState(Mutex<HashMap<String, PtySlot>>);

// Local port forwards (id -> the listener task). Aborting the task drops the
// dedicated SSH connection and closes the local listener.
#[derive(Default)]
struct ForwardState(Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>);

// Embedded MCP server state (off by default). Bound to 127.0.0.1, bearer-token
// auth, per-host opt-in, and every command requires interactive user approval.
#[derive(Default)]
struct McpState {
    running: AtomicBool,
    token: Mutex<String>,
    counter: AtomicU64,
    pending: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<bool>>>,
    log: Mutex<Vec<serde_json::Value>>,
}

fn sftp_of(state: &SftpState, id: &str) -> Result<Arc<SftpSession>, String> {
    state
        .0
        .lock()
        .unwrap()
        .get(id)
        .map(|t| t.0.clone())
        .ok_or_else(|| "SFTP not connected".to_string())
}

fn human_size(n: u64) -> String {
    const U: [&str; 5] = ["B", "K", "M", "G", "T"];
    let mut f = n as f64;
    let mut i = 0;
    while f >= 1024.0 && i < U.len() - 1 {
        f /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n}B")
    } else {
        format!("{f:.1}{}", U[i])
    }
}

fn sort_entries(v: &mut [FileEntry]) {
    v.sort_by(|a, b| {
        (b.kind == "dir")
            .cmp(&(a.kind == "dir"))
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

// Client config with keepalive so idle sessions don't silently drop (a NAT /
// firewall idle-timeout otherwise kills long-lived terminals & forwards). 30s
// ping, give up after 3 unanswered.
fn ssh_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    })
}

// Shared SSH authentication, used by both the terminal and SFTP connections.
async fn do_auth(
    session: &mut client::Handle<Handler>,
    user: &str,
    auth: &str,
    secret: &str,
    key_path: &str,
    key_text: &str,
) -> Result<(), String> {
    let res = match auth {
        "key" => {
            let pass = if secret.is_empty() { None } else { Some(secret) };
            let key = if !key_text.is_empty() {
                // Pasted key text — decode from memory (never written to disk).
                decode_secret_key(key_text, pass).map_err(|e| format!("decode key: {e}"))?
            } else {
                // Expand a leading ~/ since load_secret_key won't.
                let path = key_path
                    .strip_prefix("~/")
                    .map(|rest| format!("{}/{}", std::env::var("HOME").unwrap_or_default(), rest))
                    .unwrap_or_else(|| key_path.to_string());
                load_secret_key(&path, pass).map_err(|e| format!("load key {path}: {e}"))?
            };
            let hash = session
                .best_supported_rsa_hash()
                .await
                .map_err(|e| format!("auth: {e}"))?
                .flatten();
            session
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|e| format!("auth: {e}"))?
        }
        // ssh-agent talks over SSH_AUTH_SOCK (Unix). russh's connect_env is
        // Unix-only, so on Windows fall back to password/key auth.
        #[cfg(not(unix))]
        "agent" => {
            return Err("ssh-agent authentication is only available on macOS and Linux".into());
        }
        #[cfg(unix)]
        "agent" => {
            let mut agent = AgentClient::connect_env()
                .await
                .map_err(|e| format!("ssh-agent connect (is SSH_AUTH_SOCK set?): {e}"))?;
            let ids = agent
                .request_identities()
                .await
                .map_err(|e| format!("ssh-agent identities: {e}"))?;
            if ids.is_empty() {
                return Err("ssh-agent has no keys loaded (try `ssh-add`)".into());
            }
            let hash = session
                .best_supported_rsa_hash()
                .await
                .map_err(|e| format!("auth: {e}"))?
                .flatten();
            let mut last = None;
            for id in ids {
                let res = match id {
                    AgentIdentity::PublicKey { key, .. } => {
                        session
                            .authenticate_publickey_with(user, key, hash, &mut agent)
                            .await
                    }
                    AgentIdentity::Certificate { certificate, .. } => {
                        session
                            .authenticate_certificate_with(user, certificate, hash, &mut agent)
                            .await
                    }
                }
                .map_err(|e| format!("ssh-agent auth: {e}"))?;
                let ok = res.success();
                last = Some(res);
                if ok {
                    break;
                }
            }
            last.ok_or_else(|| "ssh-agent: no identity accepted".to_string())?
        }
        _ => {
            let mut res = session
                .authenticate_password(user, secret)
                .await
                .map_err(|e| format!("auth: {e}"))?;
            // Fallback: many servers (PAM) accept passwords only via
            // keyboard-interactive — `ssh` tries this too.
            if !res.success() {
                let mut step = session
                    .authenticate_keyboard_interactive_start(user, None::<String>)
                    .await
                    .map_err(|e| format!("auth: {e}"))?;
                // Cap rounds so a server looping InfoRequests can't hang us.
                for _ in 0..10 {
                    match step {
                        KeyboardInteractiveAuthResponse::Success => {
                            res = AuthResult::Success;
                            break;
                        }
                        KeyboardInteractiveAuthResponse::Failure { .. } => break,
                        KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                            let answers = vec![secret.to_string(); prompts.len()];
                            step = session
                                .authenticate_keyboard_interactive_respond(answers)
                                .await
                                .map_err(|e| format!("auth: {e}"))?;
                        }
                    }
                }
            }
            res
        }
    };
    if !res.success() {
        return Err(format!("authentication failed — server reports {res:?}"));
    }
    Ok(())
}

// A jump (bastion) host the target is reached through (ProxyJump). Its own
// credentials, resolved from another saved host by the frontend.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Jump {
    host: String,
    port: u16,
    user: String,
    auth: String,
    secret: String,
    key_path: String,
    key_text: String,
}

// Connect (and host-key-check) to `host:port`, directly or tunnelled through a
// single jump host. Returns the target handle plus the jump handle, which must
// be kept alive for as long as the target connection lives (drop it and the
// tunnel closes). The target's unknown/changed-key errors keep the structured
// UNKNOWN_HOST / KEY_CHANGED form the UI already handles. ponytail: one hop
// only — the jump host's own ProxyJump is ignored; chain support if anyone asks.
async fn open_session(
    host: &str,
    port: u16,
    jump: Option<&Jump>,
) -> Result<(client::Handle<Handler>, Option<client::Handle<Handler>>), String> {
    let issue = Arc::new(Mutex::new(None));
    let handler = Handler { host: host.into(), port, issue: issue.clone(), remote: None };
    let config = ssh_config();

    let (connect_res, jump_handle) = match jump {
        None => (client::connect(config, (host, port), handler).await, None),
        Some(j) => {
            // Bring up the jump host on its own handler so its key is verified
            // too; we refuse (not auto-trust) an unknown/changed jump key.
            let jissue = Arc::new(Mutex::new(None));
            let jhandler = Handler { host: j.host.clone(), port: j.port, issue: jissue.clone(), remote: None };
            let jres = client::connect(ssh_config(), (j.host.as_str(), j.port), jhandler).await;
            match jissue.lock().unwrap().take() {
                Some(KeyIssue::Unknown(fp, _)) => return Err(format!(
                    "jump host {} is not yet trusted (key {fp}). Open a direct session to it once to verify and trust its key, then retry.", j.host)),
                Some(KeyIssue::Changed) => return Err(format!(
                    "jump host {} key CHANGED — possible man-in-the-middle; refusing.", j.host)),
                None => {}
            }
            let mut jsession = jres.map_err(|e| format!("jump connect: {e}"))?;
            do_auth(&mut jsession, &j.user, &j.auth, &j.secret, &j.key_path, &j.key_text)
                .await
                .map_err(|e| format!("jump auth: {e}"))?;
            let ch = jsession
                .channel_open_direct_tcpip(host.to_string(), port as u32, "127.0.0.1".to_string(), 0u32)
                .await
                .map_err(|e| format!("jump tunnel to {host}:{port}: {e}"))?;
            (client::connect_stream(config, ch.into_stream(), handler).await, Some(jsession))
        }
    };
    // Structured key errors for the target (\u{1} = field separator).
    match issue.lock().unwrap().take() {
        Some(KeyIssue::Unknown(fp, key)) => return Err(format!("UNKNOWN_HOST\u{1}{fp}\u{1}{key}")),
        Some(KeyIssue::Changed) => return Err("KEY_CHANGED".to_string()),
        None => {}
    }
    let session = connect_res.map_err(|e| format!("connect: {e}"))?;
    Ok((session, jump_handle))
}

#[tauri::command]
async fn ssh_connect(
    state: State<'_, SshState>,
    session_id: String,
    host: String,
    port: u16,
    user: String,
    auth: String,
    secret: String,
    key_path: String,
    key_text: String,
    jump: Option<Jump>,
    cols: u16,
    rows: u16,
    on_data: Channel<Vec<u8>>,
    on_close: Channel<String>,
) -> Result<(), String> {
    // Drop any existing session reusing this id before starting a new one.
    if let Some(tx) = state.0.lock().unwrap().remove(&session_id) {
        let _ = tx.send(SshCmd::Close);
    }

    let (mut session, jump_handle) = open_session(&host, port, jump.as_ref()).await?;

    do_auth(&mut session, &user, &auth, &secret, &key_path, &key_text).await?;

    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("channel: {e}"))?;
    channel
        .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await
        .map_err(|e| format!("pty: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("shell: {e}"))?;

    let (tx, mut rx) = unbounded_channel::<SshCmd>();
    state.0.lock().unwrap().insert(session_id, tx);

    tauri::async_runtime::spawn(async move {
        let _session = session; // keep the connection alive for the task's lifetime
        let _jump = jump_handle; // keep the jump tunnel open for the same lifetime
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) => {
                            let _ = on_data.send(data.to_vec());
                        }
                        Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            let _ = on_data.send(data.to_vec());
                        }
                        Some(ChannelMsg::ExitStatus { .. }) | None => {
                            let _ = on_close.send("closed".into());
                            break;
                        }
                        _ => {}
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(SshCmd::Data(d)) => { let _ = channel.data(&d[..]).await; }
                        Some(SshCmd::Resize(c, r)) => { let _ = channel.window_change(c, r, 0, 0).await; }
                        Some(SshCmd::Close) | None => {
                            let _ = channel.eof().await;
                            break;
                        }
                    }
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn ssh_write(state: State<'_, SshState>, session_id: String, data: String) -> Result<(), String> {
    if let Some(tx) = state.0.lock().unwrap().get(&session_id) {
        tx.send(SshCmd::Data(data.into_bytes()))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn ssh_resize(state: State<'_, SshState>, session_id: String, cols: u16, rows: u16) {
    if let Some(tx) = state.0.lock().unwrap().get(&session_id) {
        let _ = tx.send(SshCmd::Resize(cols as u32, rows as u32));
    }
}

#[tauri::command]
fn ssh_disconnect(state: State<'_, SshState>, session_id: String) {
    if let Some(tx) = state.0.lock().unwrap().remove(&session_id) {
        let _ = tx.send(SshCmd::Close);
    }
}

// ---- local config store: ~/.ssh-ache/<name>.json (non-secret data only) ----

fn config_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = std::path::Path::new(&home).join(".ssh-ache");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

fn config_path(name: &str) -> Result<std::path::PathBuf, String> {
    // Only a simple file stem — no path traversal from the UI.
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("bad config name".into());
    }
    Ok(config_dir()?.join(format!("{name}.json")))
}

#[tauri::command]
fn read_config(name: String) -> Result<String, String> {
    let path = config_path(&name)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read: {e}")),
    }
}

#[tauri::command]
fn write_config(name: String, data: String) -> Result<(), String> {
    let path = config_path(&name)?;
    std::fs::write(&path, data).map_err(|e| format!("write: {e}"))
}

// ---- secrets -----------------------------------------------------------
// Primary store is a 0600 file in the app data dir (~/.ssh-ache/secrets.json) —
// same access posture as ~/.ssh/id_rsa, and reliable on unsigned builds where
// macOS keychain access (bound to the app's code signature) is flaky. The OS
// keychain is still mirrored best-effort and read as a fallback so existing
// keychain secrets keep working.
fn secret_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("sshache", id).map_err(|e| e.to_string())
}

fn secrets_load() -> std::collections::HashMap<String, String> {
    config_path("secrets")
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn secrets_store(map: &std::collections::HashMap<String, String>) -> Result<(), String> {
    let path = config_path("secrets")?;
    let data = serde_json::to_string(map).map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| format!("write secrets: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
fn secret_get(id: String) -> Result<String, String> {
    let map = secrets_load();
    if let Some(v) = map.get(&id) {
        if !v.is_empty() {
            return Ok(v.clone());
        }
    }
    // fall back to the OS keychain (older installs that stored there)
    if let Ok(entry) = secret_entry(&id) {
        if let Ok(p) = entry.get_password() {
            return Ok(p);
        }
    }
    Ok(String::new())
}

#[tauri::command]
fn secret_set(id: String, value: String) -> Result<(), String> {
    let mut map = secrets_load();
    map.insert(id.clone(), value.clone());
    secrets_store(&map)?;
    // best-effort keychain mirror (ignored if it fails, e.g. unsigned build)
    if let Ok(entry) = secret_entry(&id) {
        let _ = entry.set_password(&value);
    }
    Ok(())
}

#[tauri::command]
fn secret_delete(id: String) -> Result<(), String> {
    let mut map = secrets_load();
    if map.remove(&id).is_some() {
        let _ = secrets_store(&map);
    }
    if let Ok(entry) = secret_entry(&id) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

// Persist a server key to ~/.ssh/known_hosts after the user confirms it (Phase 3).
#[tauri::command]
fn trust_host(host: String, port: u16, key: String) -> Result<(), String> {
    let pk = PublicKey::from_openssh(&key).map_err(|e| format!("parse key: {e}"))?;
    learn_known_hosts(&host, port, &pk).map_err(|e| format!("learn: {e}"))?;
    Ok(())
}

// ---- SFTP commands (Phase 4) ----

#[tauri::command]
async fn sftp_connect(
    state: State<'_, SftpState>,
    id: String,
    host: String,
    port: u16,
    user: String,
    auth: String,
    secret: String,
    key_path: String,
    key_text: String,
    jump: Option<Jump>,
) -> Result<String, String> {
    // Drop any previous SFTP session reusing this id.
    let prev = state.0.lock().unwrap().remove(&id);
    drop(prev);

    // Same path as the terminal: host-key verification, jump-host tunnelling,
    // and full auth (password / key file / pasted key text / agent).
    let (mut session, jump_handle) = open_session(&host, port, jump.as_ref()).await?;
    do_auth(&mut session, &user, &auth, &secret, &key_path, &key_text).await?;

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("channel: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("sftp subsystem: {e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("sftp init: {e}"))?;
    let home = sftp
        .canonicalize(".")
        .await
        .unwrap_or_else(|_| "/".to_string());
    state.0.lock().unwrap().insert(id, (Arc::new(sftp), session, jump_handle));
    Ok(home)
}

// Read the remote shell's command history to seed the terminal autosuggest on connect. Best-effort:
// opens its own short-lived authenticated session (same path as the SFTP panel — never touches the
// live PTY channel), reads ~/.zsh_history + ~/.bash_history, and returns the raw text for the
// frontend to parse. Returns "" if nothing is readable. The history stays on the user's machine.
#[tauri::command]
async fn ssh_history(
    host: String,
    port: u16,
    user: String,
    auth: String,
    secret: String,
    key_path: String,
    key_text: String,
    jump: Option<Jump>,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let (mut session, _jump) = open_session(&host, port, jump.as_ref()).await?;
    do_auth(&mut session, &user, &auth, &secret, &key_path, &key_text).await?;
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("channel: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("sftp subsystem: {e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("sftp init: {e}"))?;
    let home = sftp.canonicalize(".").await.unwrap_or_else(|_| ".".to_string());
    let home = home.trim_end_matches('/');
    let mut out = String::new();
    const CAP: usize = 512 * 1024; // keep the tail; a huge history can't balloon memory
    for name in [".zsh_history", ".bash_history"] {
        let path = format!("{home}/{name}");
        if let Ok(mut f) = sftp.open(&path).await {
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).await.is_ok() {
                let slice: &[u8] = if buf.len() > CAP { &buf[buf.len() - CAP..] } else { &buf };
                out.push_str(&String::from_utf8_lossy(slice)); // lossy: partial UTF-8 → safe
                out.push('\n');
            }
        }
    }
    // _jump is held until here so the tunnel stays up for the reads.
    Ok(out)
}

#[tauri::command]
async fn sftp_list(
    state: State<'_, SftpState>,
    id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let sftp = sftp_of(&state, &id)?;
    let entries = sftp.read_dir(&path).await.map_err(|e| format!("list: {e}"))?;
    let mut out = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata();
        let is_dir = meta.is_dir();
        let size = if is_dir {
            "—".to_string()
        } else {
            human_size(meta.size.unwrap_or(0))
        };
        out.push(FileEntry {
            name,
            kind: if is_dir { "dir".into() } else { "file".into() },
            size,
        });
    }
    sort_entries(&mut out);
    Ok(out)
}

#[tauri::command]
async fn sftp_put(
    state: State<'_, SftpState>,
    id: String,
    local_path: String,
    remote_path: String,
    on_progress: Channel<u32>,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let sftp = sftp_of(&state, &id)?;
    let data = tokio::fs::read(&local_path)
        .await
        .map_err(|e| format!("read local: {e}"))?;
    let total = data.len();
    let mut file = sftp
        .create(&remote_path)
        .await
        .map_err(|e| format!("create remote: {e}"))?;
    let mut written = 0usize;
    let mut last = 0u32;
    for chunk in data.chunks(32768) {
        file.write_all(chunk).await.map_err(|e| format!("write: {e}"))?;
        written += chunk.len();
        let pct = if total == 0 { 100 } else { (written * 100 / total) as u32 };
        if pct != last {
            last = pct;
            let _ = on_progress.send(pct);
        }
    }
    file.flush().await.map_err(|e| format!("flush: {e}"))?;
    file.shutdown().await.ok();
    let _ = on_progress.send(100);
    Ok(())
}

#[tauri::command]
async fn sftp_get(
    state: State<'_, SftpState>,
    id: String,
    remote_path: String,
    local_path: String,
    on_progress: Channel<u32>,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let sftp = sftp_of(&state, &id)?;
    let total = sftp
        .metadata(&remote_path)
        .await
        .ok()
        .and_then(|m| m.size)
        .unwrap_or(0) as usize;
    let mut file = sftp
        .open(&remote_path)
        .await
        .map_err(|e| format!("open remote: {e}"))?;
    let mut out = tokio::fs::File::create(&local_path)
        .await
        .map_err(|e| format!("create local: {e}"))?;
    let mut buf = vec![0u8; 32768];
    let mut done = 0usize;
    let mut last = 0u32;
    loop {
        let n = file.read(&mut buf).await.map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])
            .await
            .map_err(|e| format!("write local: {e}"))?;
        done += n;
        if total > 0 {
            let pct = (done * 100 / total) as u32;
            if pct != last {
                last = pct;
                let _ = on_progress.send(pct);
            }
        }
    }
    out.flush().await.map_err(|e| format!("flush: {e}"))?;
    let _ = on_progress.send(100);
    Ok(())
}

// Download a remote SFTP file to a temp dir and open it with the local default app ("Open with"
// a remote file). ponytail: no progress channel — for quick document opens; big files still work,
// just without a bar. The temp copy is the user's own file from their own server; opening it uses
// the OS default handler, the same trust model as double-clicking it in Finder/Explorer.
#[tauri::command]
async fn sftp_open_external(
    state: State<'_, SftpState>,
    id: String,
    remote_path: String,
    name: String,
) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let sftp = sftp_of(&state, &id)?;
    // Bare basename only, so a crafted name can't escape the temp dir.
    let base = std::path::Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty() && *s != "." && *s != "..")
        .ok_or("invalid file name")?
        .to_string();
    let dir = std::env::temp_dir().join("sshache-open");
    std::fs::create_dir_all(&dir).map_err(|e| format!("temp dir: {e}"))?;
    let local = dir.join(&base);
    let mut file = sftp
        .open(&remote_path)
        .await
        .map_err(|e| format!("open remote: {e}"))?;
    let mut out = tokio::fs::File::create(&local)
        .await
        .map_err(|e| format!("create temp: {e}"))?;
    let mut buf = vec![0u8; 32768];
    loop {
        let n = file.read(&mut buf).await.map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])
            .await
            .map_err(|e| format!("write temp: {e}"))?;
    }
    out.flush().await.map_err(|e| format!("flush: {e}"))?;
    let local_str = local.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    let prog = "open";
    #[cfg(target_os = "windows")]
    let prog = "explorer";
    #[cfg(all(unix, not(target_os = "macos")))]
    let prog = "xdg-open";
    std::process::Command::new(prog)
        .arg(&local_str)
        .spawn()
        .map_err(|e| format!("open: {e}"))?;
    Ok(local_str)
}

// Recursive upload: walk the local tree, mkdir remote dirs, put each file.
// Progress is by file count. ponytail: iterative walk (no async recursion).
#[tauri::command]
async fn sftp_put_dir(
    state: State<'_, SftpState>,
    id: String,
    local_path: String,
    remote_path: String,
    on_progress: Channel<u32>,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let sftp = sftp_of(&state, &id)?;
    let mut stack = vec![(local_path, remote_path)];
    let mut mkdirs: Vec<String> = Vec::new();
    let mut files: Vec<(String, String)> = Vec::new();
    while let Some((ld, rd)) = stack.pop() {
        mkdirs.push(rd.clone());
        for e in std::fs::read_dir(&ld).map_err(|e| format!("read {ld}: {e}"))? {
            let e = e.map_err(|e| e.to_string())?;
            let name = e.file_name().to_string_lossy().to_string();
            let lp = format!("{ld}/{name}");
            let rp = format!("{rd}/{name}");
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push((lp, rp)),
                _ => files.push((lp, rp)),
            }
        }
    }
    for d in &mkdirs {
        let _ = sftp.create_dir(d).await; // ignore "already exists"
    }
    let total = files.len().max(1);
    let mut last = 0u32;
    for (i, (lp, rp)) in files.iter().enumerate() {
        let data = tokio::fs::read(lp).await.map_err(|e| format!("read {lp}: {e}"))?;
        let mut f = sftp.create(rp).await.map_err(|e| format!("create {rp}: {e}"))?;
        f.write_all(&data).await.map_err(|e| e.to_string())?;
        f.flush().await.ok();
        f.shutdown().await.ok();
        let pct = ((i + 1) * 100 / total) as u32;
        if pct != last {
            last = pct;
            let _ = on_progress.send(pct);
        }
    }
    let _ = on_progress.send(100);
    Ok(())
}

// Recursive download: walk the remote tree, mkdir local dirs, get each file.
#[tauri::command]
async fn sftp_get_dir(
    state: State<'_, SftpState>,
    id: String,
    remote_path: String,
    local_path: String,
    on_progress: Channel<u32>,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let sftp = sftp_of(&state, &id)?;
    let mut stack = vec![(remote_path, local_path)];
    let mut mkdirs: Vec<String> = Vec::new();
    let mut files: Vec<(String, String)> = Vec::new();
    while let Some((rd, ld)) = stack.pop() {
        mkdirs.push(ld.clone());
        let entries = sftp.read_dir(&rd).await.map_err(|e| format!("list {rd}: {e}"))?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let rp = format!("{rd}/{name}");
            let lp = format!("{ld}/{name}");
            if entry.metadata().is_dir() {
                stack.push((rp, lp));
            } else {
                files.push((rp, lp));
            }
        }
    }
    for d in &mkdirs {
        let _ = std::fs::create_dir_all(d);
    }
    let total = files.len().max(1);
    let mut last = 0u32;
    for (i, (rp, lp)) in files.iter().enumerate() {
        let mut rf = sftp.open(rp).await.map_err(|e| format!("open {rp}: {e}"))?;
        let mut out = tokio::fs::File::create(lp).await.map_err(|e| format!("create {lp}: {e}"))?;
        let mut buf = vec![0u8; 32768];
        loop {
            let n = rf.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        }
        out.flush().await.ok();
        let pct = ((i + 1) * 100 / total) as u32;
        if pct != last {
            last = pct;
            let _ = on_progress.send(pct);
        }
    }
    let _ = on_progress.send(100);
    Ok(())
}

#[tauri::command]
fn sftp_disconnect(state: State<'_, SftpState>, id: String) {
    state.0.lock().unwrap().remove(&id);
}

#[tauri::command]
async fn sftp_mkdir(state: State<'_, SftpState>, id: String, path: String) -> Result<(), String> {
    sftp_of(&state, &id)?.create_dir(path).await.map_err(|e| format!("mkdir: {e}"))
}

#[tauri::command]
async fn sftp_rename(state: State<'_, SftpState>, id: String, from: String, to: String) -> Result<(), String> {
    sftp_of(&state, &id)?.rename(from, to).await.map_err(|e| format!("rename: {e}"))
}

// Delete a remote file, or a directory (recursively — SFTP rmdir refuses a
// non-empty dir, so walk + remove depth-first).
#[tauri::command]
async fn sftp_remove(state: State<'_, SftpState>, id: String, path: String, is_dir: bool) -> Result<(), String> {
    let sftp = sftp_of(&state, &id)?;
    if !is_dir {
        return sftp.remove_file(path).await.map_err(|e| format!("delete: {e}"));
    }
    // Post-order walk: collect dirs top-down, delete files as found, then rmdir
    // dirs bottom-up.
    let mut stack = vec![path.clone()];
    let mut dirs: Vec<String> = Vec::new();
    while let Some(d) = stack.pop() {
        dirs.push(d.clone());
        let entries = sftp.read_dir(&d).await.map_err(|e| format!("list {d}: {e}"))?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let p = format!("{d}/{name}");
            if entry.metadata().is_dir() {
                stack.push(p);
            } else {
                sftp.remove_file(&p).await.map_err(|e| format!("delete {p}: {e}"))?;
            }
        }
    }
    for d in dirs.iter().rev() {
        sftp.remove_dir(d).await.map_err(|e| format!("rmdir {d}: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn local_list(path: String) -> Result<Vec<FileEntry>, String> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(&path).map_err(|e| format!("list: {e}"))? {
        let e = e.map_err(|e| e.to_string())?;
        let md = match e.metadata() {
            Ok(md) => md,
            Err(_) => continue,
        };
        let is_dir = md.is_dir();
        out.push(FileEntry {
            name: e.file_name().to_string_lossy().to_string(),
            kind: if is_dir { "dir".into() } else { "file".into() },
            size: if is_dir { "—".to_string() } else { human_size(md.len()) },
        });
    }
    sort_entries(&mut out);
    Ok(out)
}

#[tauri::command]
fn local_home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}

// Read/write an arbitrary file path — used for encrypted import/export, with the
// path chosen by the user via a native dialog. ponytail: unscoped on purpose;
// only our own (trusted) frontend can invoke it, and the payload is already
// ciphertext.
#[tauri::command]
fn write_file(path: String, data: String) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| format!("write: {e}"))
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"))
}

// Return ~/.ssh/config verbatim (empty if absent) for the frontend importer to
// parse. Read-only; never written.
#[tauri::command]
fn read_ssh_config() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let path = std::path::Path::new(&home).join(".ssh").join("config");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read: {e}")),
    }
}

// ---- local shell (PTY) ----

#[tauri::command]
fn pty_spawn(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
    on_data: Channel<Vec<u8>>,
    on_close: Channel<String>,
) -> Result<(), String> {
    if let Some(mut slot) = state.0.lock().unwrap().remove(&id) {
        let _ = slot.child.kill();
    }
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = on_close.send("closed".into());
                    break;
                }
                Ok(n) => {
                    if on_data.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    state
        .0
        .lock()
        .unwrap()
        .insert(id, PtySlot { master: pair.master, writer, child });
    Ok(())
}

#[tauri::command]
fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    if let Some(slot) = state.0.lock().unwrap().get_mut(&id) {
        slot.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        slot.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(state: State<'_, PtyState>, id: String, cols: u16, rows: u16) {
    if let Some(slot) = state.0.lock().unwrap().get(&id) {
        let _ = slot.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
}

#[tauri::command]
fn pty_close(state: State<'_, PtyState>, id: String) {
    if let Some(mut slot) = state.0.lock().unwrap().remove(&id) {
        let _ = slot.child.kill();
    }
}

// ---- local port forwarding (-L): listen on 127.0.0.1:local_port, tunnel each
// connection to remote_host:remote_port over a dedicated SSH session ----

#[tauri::command]
async fn forward_start(
    state: State<'_, ForwardState>,
    id: String,
    host: String,
    port: u16,
    user: String,
    auth: String,
    secret: String,
    key_path: String,
    key_text: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<(), String> {
    if let Some(h) = state.0.lock().unwrap().remove(&id) {
        h.abort();
    }
    let config = ssh_config();
    let handler = Handler {
        host: host.clone(),
        port,
        issue: Arc::new(Mutex::new(None)),
        remote: None,
    };
    let mut session = client::connect(config, (host, port), handler)
        .await
        .map_err(|e| format!("connect: {e}"))?;
    do_auth(&mut session, &user, &auth, &secret, &key_path, &key_text).await?;
    let session = Arc::new(session);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| format!("bind 127.0.0.1:{local_port}: {e}"))?;

    let task = tauri::async_runtime::spawn(async move {
        let session = session; // keep the SSH connection alive for the task
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(x) => x,
                Err(_) => break,
            };
            let session = session.clone();
            let rh = remote_host.clone();
            tokio::spawn(async move {
                let ch = match session
                    .channel_open_direct_tcpip(rh, remote_port as u32, "127.0.0.1".to_string(), local_port as u32)
                    .await
                {
                    Ok(c) => c,
                    Err(_) => return,
                };
                let mut stream = ch.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            });
        }
    });
    state.0.lock().unwrap().insert(id, task);
    Ok(())
}

#[tauri::command]
fn forward_stop(state: State<'_, ForwardState>, id: String) {
    if let Some(h) = state.0.lock().unwrap().remove(&id) {
        h.abort();
    }
}

// ---- dynamic SOCKS proxy (-D): a local SOCKS5 server that tunnels each
// requested target over the SSH connection via a direct-tcpip channel ----

// Minimal SOCKS5 (CONNECT only, no auth) over one accepted socket. Reads the
// greeting + request, opens an SSH channel to the requested target, replies
// success, then bridges. ponytail: no auth, no BIND/UDP — enough to drive a
// browser/curl `socks5h://127.0.0.1:<port>`.
async fn handle_socks(mut socket: tokio::net::TcpStream, session: Arc<client::Handle<Handler>>, local_port: u16) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // Greeting: VER, NMETHODS, METHODS...
    let mut head = [0u8; 2];
    socket.read_exact(&mut head).await.map_err(|e| e.to_string())?;
    if head[0] != 0x05 {
        return Err("not SOCKS5".into());
    }
    let mut methods = vec![0u8; head[1] as usize];
    socket.read_exact(&mut methods).await.map_err(|e| e.to_string())?;
    socket.write_all(&[0x05, 0x00]).await.map_err(|e| e.to_string())?; // no auth

    // Request: VER, CMD, RSV, ATYP, ADDR, PORT
    let mut req = [0u8; 4];
    socket.read_exact(&mut req).await.map_err(|e| e.to_string())?;
    if req[1] != 0x01 {
        // only CONNECT; reply "command not supported"
        let _ = socket.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        return Err("only CONNECT supported".into());
    }
    let dest = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            socket.read_exact(&mut a).await.map_err(|e| e.to_string())?;
            format!("{}.{}.{}.{}", a[0], a[1], a[2], a[3])
        }
        0x03 => {
            let mut l = [0u8; 1];
            socket.read_exact(&mut l).await.map_err(|e| e.to_string())?;
            let mut d = vec![0u8; l[0] as usize];
            socket.read_exact(&mut d).await.map_err(|e| e.to_string())?;
            String::from_utf8_lossy(&d).to_string()
        }
        0x04 => {
            let mut a = [0u8; 16];
            socket.read_exact(&mut a).await.map_err(|e| e.to_string())?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => {
            let _ = socket.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
            return Err("bad address type".into());
        }
    };
    let mut pb = [0u8; 2];
    socket.read_exact(&mut pb).await.map_err(|e| e.to_string())?;
    let dport = u16::from_be_bytes(pb);

    let ch = match session
        .channel_open_direct_tcpip(dest.clone(), dport as u32, "127.0.0.1".to_string(), local_port as u32)
        .await
    {
        Ok(c) => c,
        Err(e) => {
            // "host unreachable"
            let _ = socket.write_all(&[0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
            return Err(format!("open {dest}:{dport}: {e}"));
        }
    };
    // Success — bound address reported as 0.0.0.0:0 (clients ignore it).
    socket.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await.map_err(|e| e.to_string())?;
    let mut stream = ch.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
    Ok(())
}

#[tauri::command]
async fn socks_start(
    state: State<'_, ForwardState>,
    id: String,
    host: String,
    port: u16,
    user: String,
    auth: String,
    secret: String,
    key_path: String,
    key_text: String,
    local_port: u16,
) -> Result<(), String> {
    if let Some(h) = state.0.lock().unwrap().remove(&id) {
        h.abort();
    }
    let handler = Handler { host: host.clone(), port, issue: Arc::new(Mutex::new(None)), remote: None };
    let mut session = client::connect(ssh_config(), (host, port), handler)
        .await
        .map_err(|e| format!("connect: {e}"))?;
    do_auth(&mut session, &user, &auth, &secret, &key_path, &key_text).await?;
    let session = Arc::new(session);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| format!("bind 127.0.0.1:{local_port}: {e}"))?;

    let task = tauri::async_runtime::spawn(async move {
        let session = session;
        loop {
            let (socket, _) = match listener.accept().await {
                Ok(x) => x,
                Err(_) => break,
            };
            let session = session.clone();
            tokio::spawn(async move {
                let _ = handle_socks(socket, session, local_port).await;
            });
        }
    });
    state.0.lock().unwrap().insert(id, task);
    Ok(())
}

// ---- remote forward (-R): ask the server to listen on remote_port and bridge
// each connection back to local_host:local_port (handled in the Handler) ----

#[tauri::command]
async fn remote_forward_start(
    state: State<'_, ForwardState>,
    id: String,
    host: String,
    port: u16,
    user: String,
    auth: String,
    secret: String,
    key_path: String,
    key_text: String,
    remote_port: u16,
    local_host: String,
    local_port: u16,
) -> Result<(), String> {
    if let Some(h) = state.0.lock().unwrap().remove(&id) {
        h.abort();
    }
    let handler = Handler {
        host: host.clone(),
        port,
        issue: Arc::new(Mutex::new(None)),
        remote: Some((local_host, local_port)),
    };
    let mut session = client::connect(ssh_config(), (host, port), handler)
        .await
        .map_err(|e| format!("connect: {e}"))?;
    do_auth(&mut session, &user, &auth, &secret, &key_path, &key_text).await?;
    session
        .tcpip_forward("0.0.0.0", remote_port as u32)
        .await
        .map_err(|e| format!("remote forward request (server may forbid GatewayPorts): {e}"))?;

    // Hold the session open; the Handler bridges forwarded channels. Aborting
    // the task drops the session, which tears down the remote listener.
    let task = tauri::async_runtime::spawn(async move {
        let _session = session;
        std::future::pending::<()>().await;
    });
    state.0.lock().unwrap().insert(id, task);
    Ok(())
}

// ---- MCP server (local, opt-in, approval-gated) ----

// Hosts the user has explicitly exposed to the agent (agentAllowed), read from
// the same config file the UI writes.
fn mcp_exposed_hosts() -> Result<Vec<serde_json::Value>, String> {
    let path = config_path("state")?;
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    if raw.is_empty() {
        return Ok(vec![]);
    }
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let arr = v.get("hosts").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    Ok(arr
        .into_iter()
        .filter(|h| h.get("agentAllowed").and_then(|x| x.as_bool()).unwrap_or(false))
        .collect())
}

fn mcp_tools() -> serde_json::Value {
    serde_json::json!([
        { "name": "list_hosts", "description": "List the SSH hosts the user has exposed to the agent (no secrets).", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "run_command", "description": "Run a shell command on an exposed host over SSH. Each call must be approved by the user in the SSH Ache app.", "inputSchema": { "type": "object", "properties": { "host_id": { "type": "string" }, "command": { "type": "string" } }, "required": ["host_id", "command"] } }
    ])
}

// Emit an approval request to the GUI and block until the user responds (or 2 min timeout).
fn mcp_request_approval(app: &tauri::AppHandle, host: &str, command: &str) -> bool {
    let st = app.state::<McpState>();
    let id = st.counter.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    st.pending.lock().unwrap().insert(id, tx);
    let _ = app.emit("mcp-approval", serde_json::json!({ "id": id, "host": host, "command": command }));
    let res = tauri::async_runtime::block_on(async {
        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(v)) => v,
            _ => false,
        }
    });
    st.pending.lock().unwrap().remove(&id);
    res
}

async fn mcp_ssh_exec(host: &serde_json::Value, blob: &str, command: &str) -> Result<String, String> {
    let addr = host["addr"].as_str().unwrap_or("").to_string();
    let port: u16 = host["port"].as_str().and_then(|s| s.parse().ok()).unwrap_or(22);
    let user = host["user"].as_str().unwrap_or("root").to_string();
    let auth = host["auth"].as_str().unwrap_or("password").to_string();
    let key_path = host["keyPath"].as_str().unwrap_or("").to_string();
    let sb: serde_json::Value = serde_json::from_str(blob).unwrap_or(serde_json::json!({}));
    let (secret, key_text) = if auth == "key" {
        (sb["passphrase"].as_str().unwrap_or("").to_string(), sb["keyText"].as_str().unwrap_or("").to_string())
    } else {
        (sb["password"].as_str().unwrap_or("").to_string(), String::new())
    };
    let config = ssh_config();
    let handler = Handler { host: addr.clone(), port, issue: Arc::new(Mutex::new(None)), remote: None };
    let mut session = client::connect(config, (addr, port), handler)
        .await
        .map_err(|e| format!("connect: {e}"))?;
    do_auth(&mut session, &user, &auth, &secret, &key_path, &key_text).await?;
    let mut channel = session.channel_open_session().await.map_err(|e| format!("channel: {e}"))?;
    channel.exec(true, command.as_bytes().to_vec()).await.map_err(|e| format!("exec: {e}"))?;
    let mut out: Vec<u8> = Vec::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { ref data }) => out.extend_from_slice(data),
            Some(ChannelMsg::ExtendedData { ref data, .. }) => out.extend_from_slice(data),
            Some(ChannelMsg::Eof) | None => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&out).to_string())
}

fn mcp_tool_call(app: &tauri::AppHandle, name: &str, args: &serde_json::Value) -> Result<String, String> {
    let hosts = mcp_exposed_hosts()?;
    match name {
        "list_hosts" => {
            let list: Vec<_> = hosts.iter().map(|h| serde_json::json!({
                "id": h["id"],
                "name": h["name"],
                "target": format!("{}@{}:{}", h["user"].as_str().unwrap_or("root"), h["addr"].as_str().unwrap_or(""), h["port"].as_str().unwrap_or("22")),
                "auth": h["auth"],
                "tags": h["tags"],
            })).collect();
            Ok(serde_json::to_string_pretty(&list).unwrap_or_default())
        }
        "run_command" => {
            let host_id = args["host_id"].as_str().ok_or("host_id required")?;
            let command = args["command"].as_str().ok_or("command required")?;
            let host = hosts
                .iter()
                .find(|h| h["id"].as_str() == Some(host_id))
                .ok_or("host not found or not exposed to the agent")?;
            let host_name = host["name"].as_str().unwrap_or("").to_string();
            // Per-host opt-in: auto-allow skips the approval prompt for this host. Only exposed
            // (agentAllowed) hosts reach here, and the run is still logged for transparency.
            let auto = host.get("agentAutoAllow").and_then(|x| x.as_bool()).unwrap_or(false);
            let allowed = if auto { true } else { mcp_request_approval(app, &host_name, command) };
            app.state::<McpState>().log.lock().unwrap().push(serde_json::json!({
                "host": host_name, "command": command, "allowed": allowed, "auto": auto,
            }));
            if !allowed {
                return Err("denied by user".into());
            }
            let blob = secret_entry(host_id)?.get_password().unwrap_or_default();
            tauri::async_runtime::block_on(mcp_ssh_exec(host, &blob, command))
        }
        _ => Err("unknown tool".into()),
    }
}

fn mcp_dispatch(app: &tauri::AppHandle, body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let id = v.get("id").cloned();
    let method = v.get("method").and_then(|x| x.as_str()).unwrap_or("");
    let result = match method {
        "initialize" => serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "sshache", "version": "0.4.0" }
        }),
        "ping" => serde_json::json!({}),
        "tools/list" => serde_json::json!({ "tools": mcp_tools() }),
        "tools/call" => {
            let params = v.get("params").cloned().unwrap_or(serde_json::json!({}));
            let name = params.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(serde_json::json!({}));
            match mcp_tool_call(app, name, &args) {
                Ok(text) => serde_json::json!({ "content": [{ "type": "text", "text": text }] }),
                Err(e) => serde_json::json!({ "content": [{ "type": "text", "text": format!("error: {e}") }], "isError": true }),
            }
        }
        _ => {
            if id.is_none() {
                return None;
            }
            return Some(serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "method not found" } }).to_string());
        }
    };
    if id.is_none() {
        return None; // notification — no response
    }
    Some(serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string())
}

fn mcp_handle(app: &tauri::AppHandle, mut req: tiny_http::Request) {
    let token = app.state::<McpState>().token.lock().unwrap().clone();
    let expected = format!("Bearer {token}");
    let authed = !token.is_empty()
        && req.headers().iter().any(|h| h.field.equiv("Authorization") && h.value.as_str() == expected);
    if !authed {
        let _ = req.respond(tiny_http::Response::from_string("{\"error\":\"unauthorized\"}").with_status_code(401));
        return;
    }
    let mut body = String::new();
    let _ = req.as_reader().read_to_string(&mut body);
    match mcp_dispatch(app, &body) {
        Some(json) => {
            let r = tiny_http::Response::from_string(json)
                .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
            let _ = req.respond(r);
        }
        None => {
            let _ = req.respond(tiny_http::Response::from_string("").with_status_code(202));
        }
    }
}

#[tauri::command]
fn mcp_start(app: tauri::AppHandle, state: State<'_, McpState>, token: String, port: u16) -> Result<u16, String> {
    if state.running.load(Ordering::SeqCst) {
        return Ok(port);
    }
    let server = tiny_http::Server::http(("127.0.0.1", port)).map_err(|e| format!("bind 127.0.0.1:{port}: {e}"))?;
    *state.token.lock().unwrap() = token;
    state.running.store(true, Ordering::SeqCst);
    let app2 = app.clone();
    std::thread::spawn(move || loop {
        if !app2.state::<McpState>().running.load(Ordering::SeqCst) {
            break;
        }
        match server.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(Some(req)) => mcp_handle(&app2, req),
            Ok(None) => continue,
            Err(_) => break,
        }
    });
    Ok(port)
}

#[tauri::command]
fn mcp_stop(state: State<'_, McpState>) {
    state.running.store(false, Ordering::SeqCst);
}

#[tauri::command]
fn mcp_status(state: State<'_, McpState>) -> serde_json::Value {
    serde_json::json!({
        "running": state.running.load(Ordering::SeqCst),
        "log": *state.log.lock().unwrap(),
    })
}

#[tauri::command]
fn mcp_approval_respond(state: State<'_, McpState>, id: u64, allow: bool) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(allow);
    }
}

// Open a URL in the user's default browser/mail client. Only http(s)/mailto are
// allowed so a stray value can't be coerced into running a local program.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let ok = url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:");
    if !ok {
        return Err("unsupported url scheme".into());
    }
    #[cfg(target_os = "macos")]
    let prog = "open";
    #[cfg(target_os = "windows")]
    let prog = "explorer";
    #[cfg(all(unix, not(target_os = "macos")))]
    let prog = "xdg-open";
    std::process::Command::new(prog)
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// Open a local file or folder with the OS default application ("Open with"). The path must exist
// so a stray value can't spawn an arbitrary program name; the file is then handed to the OS
// default handler — same trust model as double-clicking it in Finder/Explorer.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err("path does not exist".into());
    }
    #[cfg(target_os = "macos")]
    let prog = "open";
    #[cfg(target_os = "windows")]
    let prog = "explorer";
    #[cfg(all(unix, not(target_os = "macos")))]
    let prog = "xdg-open";
    std::process::Command::new(prog)
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SshState::default())
        .manage(SftpState::default())
        .manage(PtyState::default())
        .manage(ForwardState::default())
        .manage(McpState::default())
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_write,
            ssh_resize,
            ssh_disconnect,
            read_config,
            write_config,
            secret_get,
            secret_set,
            secret_delete,
            trust_host,
            sftp_connect,
            ssh_history,
            sftp_list,
            sftp_put,
            sftp_get,
            sftp_open_external,
            open_path,
            sftp_put_dir,
            sftp_get_dir,
            sftp_disconnect,
            sftp_mkdir,
            sftp_rename,
            sftp_remove,
            local_list,
            local_home,
            write_file,
            read_file,
            read_ssh_config,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_close,
            forward_start,
            forward_stop,
            socks_start,
            remote_forward_start,
            mcp_start,
            mcp_stop,
            mcp_status,
            mcp_approval_respond,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
