// SSH Ache Teams — desktop client for the sshache-sass zero-knowledge SaaS.
//
// Signs into the SaaS, unlocks the E2EE identity IN MEMORY (never persisted — the vault
// needs the password each launch, same as the web app on reload), then decrypts a team's
// shared SSH connections locally. The server only ever sees ciphertext + wrapped keys.
//
// Transport: plain fetch() from the Tauri webview (CORS-free) with a Bearer access token
// the server returns in the login body for `platform:'desktop'`. Refresh-on-401 keeps the
// ~15-minute access token fresh via the rotating refresh token (also body-delivered).

import * as C from './crypto/index.js';

export interface Membership {
  teamId: string;
  teamName: string;
  role: string;
  planTier: string;
  isPersonal?: boolean;
  // Server-computed feature flag (entitlementsFor(planTier).features.commandSuggest). Absent on
  // older servers → treated as enabled; explicit false = the future paid-only gate turned it off.
  commandSuggest?: boolean;
}
export interface TeamConnMeta {
  schema: 1;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: string;
}
export interface TeamConnSecret {
  schema?: 1;
  password?: string | null;
  passphrase?: string | null;
  keyText?: string | null;
}
export interface TeamConn {
  id: string;
  version: number;
  meta: TeamConnMeta;
}

export class TeamsError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface Vault {
  userId: string;
  email: string;
  identity: C.Identity;
}

// The SaaS origin is hard-wired — the desktop app only ever talks to the official backend.
let base = 'https://sshache.com';
let accessToken = '';
let refreshToken = '';
let vault: Vault | null = null;
let linkEph: C.KeyPair | null = null; // ephemeral X25519 keypair for an in-flight device link
// Cached across TeamsPanel unmount/remount (view switches): the vault lives in this module, so
// the UI must restore its memberships from here rather than re-init to [] and render blank.
let cachedMemberships: Membership[] = [];
const teamKeys = new Map<string, { tk: Uint8Array; keyGeneration: number }>();

export const isSignedIn = (): boolean => vault !== null;
export const getBase = (): string => base;
export const currentMemberships = (): Membership[] => cachedMemberships;

// Command autosuggest is a Teams-app feature. Gate: signed in with at least one membership the
// server hasn't explicitly denied. Absent flag (old server) counts as enabled, so the feature
// works before the platform ships the entitlement; flipping FREE→false later turns it off here.
export const hasCommandSuggest = (): boolean =>
  isSignedIn() && cachedMemberships.some((m) => m.commandSuggest !== false);

// Re-fetch memberships for an already-unlocked session (used to repopulate the UI on remount).
export async function loadMemberships(): Promise<Membership[]> {
  const me = await req('GET', '/v1/auth/me');
  cachedMemberships = me.memberships ?? [];
  return cachedMemberships;
}

export function signOut(): void {
  vault = null;
  cachedMemberships = [];
  accessToken = '';
  refreshToken = '';
  teamKeys.clear();
}

// ---- HTTP ----------------------------------------------------------------

interface Raw {
  status: number;
  ok: boolean;
  data: any;
}

async function raw(method: string, path: string, body?: unknown, auth = true): Promise<Raw> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && accessToken) headers['authorization'] = 'Bearer ' + accessToken;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty / non-JSON body */
  }
  return { status: res.status, ok: res.ok, data };
}

async function refresh(): Promise<void> {
  if (!refreshToken) throw new TeamsError(401, 'Session expired', 'no_refresh');
  const r = await raw('POST', '/v1/auth/refresh', { refreshToken }, false);
  if (!r.ok || !r.data?.accessToken) {
    signOut();
    throw new TeamsError(r.status, 'Session expired — sign in again', 'refresh_failed');
  }
  accessToken = r.data.accessToken;
  refreshToken = r.data.refreshToken;
}

// Authenticated request with one transparent refresh-and-retry on 401.
async function req(method: string, path: string, body?: unknown): Promise<any> {
  let r = await raw(method, path, body);
  if (r.status === 401 && refreshToken) {
    await refresh();
    r = await raw(method, path, body);
  }
  if (!r.ok) {
    throw new TeamsError(r.status, r.data?.error?.message ?? `HTTP ${r.status}`, r.data?.error?.code);
  }
  return r.data;
}

// ---- Sign in + unlock ----------------------------------------------------

export async function signIn(
  email: string,
  password: string,
): Promise<{ user: { id: string; email: string; displayName: string }; memberships: Membership[] }> {
  const login = await raw(
    'POST',
    '/v1/auth/login',
    { email, password, deviceName: 'SSH Ache Desktop', platform: 'desktop' },
    false,
  );
  if (!login.ok) {
    throw new TeamsError(login.status, login.data?.error?.message ?? 'Sign-in failed', login.data?.error?.code);
  }
  if (!login.data?.accessToken || !login.data?.refreshToken) {
    throw new TeamsError(500, 'Server did not return desktop tokens — update the server', 'no_token');
  }
  accessToken = login.data.accessToken;
  refreshToken = login.data.refreshToken;

  // Unlock the vault: password -> Master Key (Argon2id, params from the sealed vault) -> identity.
  const keys = await req('GET', '/v1/auth/keys');
  const mk = await C.deriveMasterKey(password, keys.encPrivKeys.kdf);
  const identity = await C.openIdentity(keys.encPrivKeys, mk.key, email);
  C.zero(mk.key);
  vault = { userId: login.data.user.id, email, identity };

  const me = await req('GET', '/v1/auth/me');
  cachedMemberships = me.memberships ?? [];
  return { user: me.user, memberships: cachedMemberships };
}

// ---- Presence (who's active on a team connection) ------------------------
export const currentUserId = (): string | null => (vault ? vault.userId : null);

export interface PresenceEntry {
  sessionId: string | null; // set (shadowable) for web + mirrored native sessions; null = plain heartbeat
  connectionId: string;
  userId: string;
  displayName: string;
  email?: string;
  kind: string;
}

// Report that this app is connected to a team connection (metadata only — no secrets). Best-effort.
export async function heartbeat(teamId: string, connectionId: string): Promise<void> {
  if (!vault) return;
  try {
    await req('POST', `/v1/teams/${teamId}/presence/heartbeat`, { connectionId });
  } catch {
    /* best-effort */
  }
}

export async function getPresence(teamId: string): Promise<PresenceEntry[]> {
  if (!vault) return [];
  try {
    const r = await req('GET', `/v1/teams/${teamId}/presence`);
    return r.presence ?? [];
  } catch {
    return [];
  }
}

// ---- Live spectate (watch a teammate's session) --------------------------
export interface RelayTicket {
  sessionId: string;
  relayUrl: string;
  ticket: string;
}

// Mirror THIS app's terminal output for a team connection so teammates can watch it (read-only).
// The SSH stays local; only output is streamed. Returns a relay URL + ticket, or null if unavailable.
export async function requestMirror(teamId: string, connId: string): Promise<RelayTicket | null> {
  if (!vault) return null;
  try {
    const r = await req('POST', `/v1/teams/${teamId}/connections/${connId}/webterm/mirror`);
    return { sessionId: r.sessionId, relayUrl: r.relayUrl, ticket: r.ticket };
  } catch {
    return null; // best-effort — a failed mirror never breaks the local session
  }
}

// Get a read-only ticket to watch an ACTIVE session. Throws on failure (e.g. session ended) so
// the caller can surface why.
export async function requestShadow(teamId: string, sessionId: string): Promise<RelayTicket> {
  if (!vault) throw new Error('Sign in to Teams first');
  const r = await req('POST', `/v1/teams/${teamId}/webterm/sessions/${sessionId}/shadow`);
  return { sessionId: r.sessionId, relayUrl: r.relayUrl, ticket: r.ticket };
}

// Build the relay WebSocket URL carrying the one-time ticket.
export function relayWsUrl(relayUrl: string, ticket: string): string {
  return relayUrl + (relayUrl.includes('?') ? '&' : '?') + 'ticket=' + encodeURIComponent(ticket);
}

// ---- Device linking (no email/password typed in the app) ----------------
// The app generates an ephemeral keypair, opens the web app, and the browser (already unlocked)
// seals the identity + a fresh desktop session to linkEph.publicKey. We poll for it and unseal
// locally — the server only ever relays ciphertext it can't read.

export async function startLink(): Promise<{ linkId: string; code: string; approveUrl: string }> {
  linkEph = C.newEphemeralKeypair();
  const r = await raw('POST', '/v1/device-link/start', { desktopPubKey: C.b64(linkEph.publicKey) }, false);
  if (!r.ok || !r.data?.linkId) {
    throw new TeamsError(r.status, r.data?.error?.message ?? 'Could not start linking', r.data?.error?.code);
  }
  return { linkId: r.data.linkId, code: r.data.code, approveUrl: r.data.approveUrl };
}

// Poll once. Returns { status } while pending; when the browser has approved, unseals the payload
// locally (identity + tokens), completes sign-in, and returns { status: 'linked', memberships }.
export async function claimLink(
  linkId: string,
): Promise<{ status: string; memberships?: Membership[] }> {
  if (!linkEph) throw new TeamsError(400, 'No link in progress', 'no_link');
  const r = await raw('GET', `/v1/device-link/${linkId}/status`, undefined, false);
  if (!r.ok) throw new TeamsError(r.status, r.data?.error?.message ?? 'Link check failed', r.data?.error?.code);
  const status = String(r.data?.status ?? 'pending');
  if (status !== 'approved' || !r.data?.sealedPayload) return { status };
  const opened = await C.openBox(C.unb64(r.data.sealedPayload), linkEph.secretKey);
  const p = JSON.parse(new TextDecoder().decode(opened)) as {
    email: string;
    userId: string;
    identity: string;
    accessToken: string;
    refreshToken: string;
  };
  vault = { userId: p.userId, email: p.email, identity: C.identityFromSecret(C.unb64(p.identity)) };
  accessToken = p.accessToken;
  refreshToken = p.refreshToken;
  linkEph = null;
  teamKeys.clear();
  const memberships = await loadMemberships();
  return { status: 'linked', memberships };
}

// ---- Team key + connections ---------------------------------------------

async function ensureTeamKey(teamId: string): Promise<{ tk: Uint8Array; keyGeneration: number }> {
  if (!vault) throw new TeamsError(401, 'Not signed in', 'locked');
  const cached = teamKeys.get(teamId);
  if (cached) return cached;

  const { team } = await req('GET', `/v1/teams/${teamId}`);
  try {
    const w = await req('GET', `/v1/teams/${teamId}/keys/wrap`);
    // Ed25519-verify the wrap signature (anti server-key-substitution) then sealed-box open.
    const tk = await C.verifyAndOpenTeamKeyWrap(
      C.unb64(w.wrappedTeamKey), C.unb64(w.sig), vault.identity, C.unb64(w.wrappedByEd25519Pub), teamId, vault.userId, w.keyGeneration,
    );
    const entry = { tk, keyGeneration: w.keyGeneration };
    teamKeys.set(teamId, entry);
    return entry;
  } catch (err) {
    const noWrap = err instanceof TeamsError && err.status === 404;
    const role = cachedMemberships.find((m) => m.teamId === teamId)?.role ?? '';
    if (noWrap && (role === 'OWNER' || role === 'ADMIN')) {
      // First use of this team by an admin: bootstrap a fresh Team Key and self-wrap it.
      const tk = await C.newTeamKey();
      const sw = await C.wrapTeamKeyToMember(tk, vault.identity.x25519.publicKey, vault.identity.ed25519.secretKey, teamId, vault.userId, team.keyGeneration);
      await req('POST', `/v1/teams/${teamId}/keys/wraps`, { keyGeneration: team.keyGeneration, wraps: [{ userId: vault.userId, wrappedTeamKey: C.b64(sw.wrap), sig: C.b64(sw.sig) }] });
      const entry = { tk, keyGeneration: team.keyGeneration };
      teamKeys.set(teamId, entry);
      return entry;
    }
    if (noWrap) throw new TeamsError(404, 'No Team Key shared with you yet — ask an admin to share it.', 'no_wrap');
    throw err;
  }
}

export async function listConnections(teamId: string): Promise<TeamConn[]> {
  const { tk } = await ensureTeamKey(teamId);
  const { connections } = await req('GET', `/v1/teams/${teamId}/connections`);
  return Promise.all(
    (connections as { id: string; version: number; encBlob: string }[]).map(async (c) => ({
      id: c.id,
      version: c.version,
      meta: await C.openMeta<TeamConnMeta>(C.unb64(c.encBlob), tk, c.id),
    })),
  );
}

// Returns the decrypted secret, or null if none is stored / the caller lacks a live grant.
export async function revealSecret(teamId: string, connId: string): Promise<TeamConnSecret | null> {
  const { tk } = await ensureTeamKey(teamId);
  const c = await req('GET', `/v1/teams/${teamId}/connections/${connId}`);
  if (!c.secret) return null;
  return C.openConnection<TeamConnSecret>(
    {
      ciphertext: C.unb64(c.secret.ciphertext),
      wrappedDek: C.unb64(c.secret.wrappedDek),
      keyGeneration: c.secret.keyGeneration,
    },
    tk,
    connId,
  );
}

// Per-connection last-usage (Admin/Auditor): when each connection's secret was last pulled + by
// whom. Server returns 403 for non-admins — callers should guard by role and ignore errors.
export async function listActivity(
  teamId: string,
): Promise<Record<string, { lastUsedAt: string; actorName: string }>> {
  const { activity } = await req('GET', `/v1/teams/${teamId}/connections/activity`);
  return activity ?? {};
}

// ---- Team management (all in the app now) --------------------------------
export interface TeamMember {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: string;
}
export interface TeamInvite {
  id: string;
  email: string;
  role: string;
  code: string | null;
  expiresAt: string;
}
export interface MyInvite {
  id: string;
  teamId: string;
  teamName: string;
  role: string;
  expiresAt: string;
}

// Create a team, then refresh memberships (so the new team shows up immediately).
export async function createTeam(name: string): Promise<Membership[]> {
  await req('POST', '/v1/teams', { name });
  return loadMemberships();
}

export async function listMembers(teamId: string): Promise<TeamMember[]> {
  const { members } = await req('GET', `/v1/teams/${teamId}/members`);
  return members ?? [];
}
export async function changeMemberRole(teamId: string, memberId: string, role: string): Promise<void> {
  await req('PATCH', `/v1/teams/${teamId}/members/${memberId}`, { role });
}
export async function removeMember(teamId: string, memberId: string): Promise<void> {
  await req('DELETE', `/v1/teams/${teamId}/members/${memberId}`);
}
// Leave a team yourself (any role). Refreshes memberships so the team + its synced connections drop.
export async function leaveTeam(teamId: string): Promise<Membership[]> {
  await req('POST', `/v1/teams/${teamId}/leave`);
  return loadMemberships();
}
// Delete a whole team (owner only). Refreshes memberships.
export async function deleteTeam(teamId: string): Promise<Membership[]> {
  await req('DELETE', `/v1/teams/${teamId}`);
  return loadMemberships();
}

// Invite by email → returns the shareable code.
export async function inviteMember(teamId: string, email: string, role: string): Promise<string> {
  const r = await req('POST', `/v1/teams/${teamId}/invites`, { email, role });
  return r.code as string;
}
export async function getTeamInvites(teamId: string): Promise<TeamInvite[]> {
  const { invites } = await req('GET', `/v1/teams/${teamId}/invites`);
  return invites ?? [];
}
export async function listMyInvites(): Promise<MyInvite[]> {
  const { invites } = await req('GET', '/v1/invites/mine');
  return invites ?? [];
}
export async function acceptInvite(inviteId: string): Promise<Membership[]> {
  await req('POST', `/v1/invites/${inviteId}/accept`);
  return loadMemberships();
}
export async function rejectInvite(inviteId: string): Promise<void> {
  await req('POST', `/v1/invites/${inviteId}/reject`);
}

// Wrap the Team Key to every current member (owner/admin) so they can decrypt. Idempotent.
export async function shareTeamKey(teamId: string): Promise<number> {
  if (!vault) throw new TeamsError(401, 'Not signed in', 'locked');
  const { tk, keyGeneration } = await ensureTeamKey(teamId);
  const { members } = await req('GET', `/v1/teams/${teamId}/keys/members`);
  const wraps = await Promise.all(
    (members as { userId: string; x25519Pub: string }[]).map(async (m) => {
      const w = await C.wrapTeamKeyToMember(tk, C.unb64(m.x25519Pub), vault!.identity.ed25519.secretKey, teamId, m.userId, keyGeneration);
      return { userId: m.userId, wrappedTeamKey: C.b64(w.wrap), sig: C.b64(w.sig) };
    }),
  );
  await req('POST', `/v1/teams/${teamId}/keys/wraps`, { keyGeneration, wraps });
  return wraps.length;
}

// Create a shared connection in a team/vault: seal meta + secret under the Team Key, then upload.
export async function createConnection(teamId: string, meta: TeamConnMeta, secret: TeamConnSecret): Promise<string> {
  const { tk, keyGeneration } = await ensureTeamKey(teamId);
  const connId = crypto.randomUUID();
  const encBlob = await C.sealMeta(meta, tk, connId);
  const sealed = await C.sealConnection(secret, tk, connId, keyGeneration);
  await req('POST', `/v1/teams/${teamId}/connections`, {
    id: connId,
    encBlob: C.b64(encBlob),
    cipher: 'XCHACHA20_POLY1305',
    keyGeneration,
    secret: { ciphertext: C.b64(sealed.ciphertext), wrappedDek: C.b64(sealed.wrappedDek) },
  });
  return connId;
}

// The user's personal vault team (a single-member isPersonal team), if signed in.
export const personalTeamId = (): string | null => cachedMemberships.find((m) => m.isPersonal)?.teamId ?? null;

// ---- Plan, limits & billing ----------------------------------------------
// The server is the source of truth (entitlementsFor(planTier) in @sshache/shared). The app
// never decides a plan locally — it renders what these endpoints return.
//
// NOTE: unlimited limits are `Infinity` server-side, which JSON.stringify turns into `null`.
// Treat null/absent as unlimited.

export interface Subscription {
  plan: string; // effective plan tier: FREE | PRO | ENTERPRISE
  status: string;
  billableSeats: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}
export interface Entitlements {
  plan: string;
  limits: {
    maxMembers: number | null;
    maxConnections: number | null;
    auditRetentionDays: number | null;
    connectionHistoryDays: number | null;
  };
  features: Record<string, boolean | string>;
}

export const isUnlimited = (n: number | null | undefined): boolean => n == null || !Number.isFinite(n);

export async function getSubscription(teamId: string): Promise<Subscription> {
  return (await req('GET', `/v1/teams/${teamId}/billing/subscription`)) as Subscription;
}

export async function getEntitlements(teamId: string): Promise<Entitlements> {
  return (await req('GET', `/v1/teams/${teamId}/billing/entitlements`)) as Entitlements;
}

// Owner-only. Returns a hosted checkout URL to open in the browser — the app never handles
// card details.
export async function startCheckout(teamId: string, plan: 'PRO' | 'ENTERPRISE'): Promise<string> {
  const r = await req('POST', `/v1/teams/${teamId}/billing/checkout`, { plan, interval: 'monthly' });
  return r.checkoutUrl as string;
}

// Admin+. Deep-link into the payment provider's customer portal (invoices, card, cancel).
export async function billingPortal(teamId: string): Promise<string> {
  const r = await req('POST', `/v1/teams/${teamId}/billing/portal`);
  return r.portalUrl as string;
}
