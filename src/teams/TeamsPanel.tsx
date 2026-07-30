import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import * as teams from './client.js';

// The "Teams & billing" view of SSH Ache Teams — the commercial edition.
//
// This panel is the product's identity: which team you are in, what plan it is on, what that
// plan gives you, how close you are to its limits, and every management action (invite, roles,
// keys, leave/delete). Plan facts come from the server (`entitlementsFor(planTier)`) — nothing
// here decides entitlements locally. All connection crypto stays client-side.

export interface ImportArgs {
  meta: teams.TeamConnMeta;
  secret: teams.TeamConnSecret | null;
  teamName: string;
}

interface Props {
  isTauri: boolean;
  defaults: { email: string };
  onImport: (args: ImportArgs) => void;
  onRemember: (email: string) => void;
  onSync: (force?: boolean) => Promise<number | undefined>;
  onGoDashboard: () => void;
  // Push the selected team up so the title bar / sidebar can show it.
  onTeamContext?: (teamId: string) => void;
  // Signed out from in here — let the app clear its team state (badge, sidebar account row).
  onSignedOut?: () => void;
  // Open a URL in the OS browser (Tauri webview ignores target=_blank).
  openExt?: (url: string) => void;
}

// ---- design tokens -------------------------------------------------------
// Violet is the Teams signature — the community edition is orange. Kept local to this panel and
// the Teams chrome in App.tsx so user themes still own the terminal.
const V = {
  accent: '#8b7bff',
  accentHi: '#b79bff',
  grad: 'linear-gradient(135deg,#7c6cff,#b455f7)',
  soft: 'rgba(139,123,255,.10)',
  line: 'rgba(139,123,255,.32)',
};
const GREEN = '#46d9a0';
const RED = '#ff6b78';

const card: React.CSSProperties = {
  background: '#0c0c10',
  border: '1px solid #1e1e26',
  borderRadius: 13,
  padding: 18,
};
const input: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: '#0e0e12',
  border: '1px solid #20202a',
  borderRadius: 7,
  color: '#ededf0',
  padding: '9px 11px',
  font: 'inherit',
  fontSize: 12.5,
  outline: 'none',
};
const btn = (kind?: 'primary' | 'ghost' | 'danger'): React.CSSProperties => ({
  background: kind === 'primary' ? V.grad : 'transparent',
  color: kind === 'primary' ? '#fff' : kind === 'danger' ? RED : '#b9b9c2',
  border: '1px solid ' + (kind === 'primary' ? 'transparent' : kind === 'danger' ? 'rgba(255,107,120,.35)' : '#26262e'),
  borderRadius: 8,
  padding: '8px 15px',
  font: 'inherit',
  fontSize: 12,
  fontWeight: kind === 'primary' ? 700 : 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
});
const label: React.CSSProperties = { display: 'block', marginTop: 12, color: '#8b8b95', fontSize: 12 };
const sectionTitle: React.CSSProperties = {
  fontSize: 9.5,
  letterSpacing: '.15em',
  textTransform: 'uppercase',
  color: '#54545e',
  margin: '26px 0 10px',
};

// ---- plan catalogue ------------------------------------------------------
// Display copy only — pricing shown to the user. Enforcement is server-side. Keep in sync with
// docs/11-PLANS-PRICING.md and the pricing section on sshache.com.
const PLANS = [
  {
    id: 'FREE',
    name: 'Free',
    price: '$0',
    unit: 'forever',
    tag: 'For pairs',
    perks: ['Up to 2 members', '5 shared connections', 'Personal cloud vault', 'Live presence, session view & web terminal', '7-day audit retention'],
  },
  {
    id: 'PRO',
    name: 'Pro',
    price: '$2',
    unit: '/member/mo · first 2 free',
    tag: 'Most teams',
    perks: ['Unlimited members & connections', 'Shared folders & tags', 'Access grants, JIT & approvals (API today, UI next)', 'Connection history & rollback', '90-day audit + 30-day history'],
  },
  {
    id: 'ENTERPRISE',
    name: 'Enterprise',
    price: '$3',
    unit: '/member/mo · from seat 1, 10 min',
    tag: 'Compliance',
    perks: ['Everything in Pro', 'SAML + OIDC SSO & SCIM (API today, UI next)', 'Read-only Auditor role', 'Admin key escrow & break-glass (API today, UI next)', 'Unlimited audit + SIEM export'],
  },
] as const;

const planLabel = (t: string): string => PLANS.find((p) => p.id === t)?.name ?? t;

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function dateLabel(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

// A plan badge — filled gradient when paid, muted outline on Free.
function PlanChip({ plan, size = 'sm' }: { plan: string; size?: 'sm' | 'lg' }): React.ReactElement {
  const paid = plan === 'PRO' || plan === 'ENTERPRISE';
  const big = size === 'lg';
  return (
    <span
      style={{
        fontSize: big ? 10.5 : 8.5,
        fontWeight: 800,
        letterSpacing: '.1em',
        textTransform: 'uppercase',
        borderRadius: 999,
        padding: big ? '4px 11px' : '2px 7px',
        flex: 'none',
        ...(paid
          ? { background: V.grad, color: '#fff', boxShadow: '0 2px 12px rgba(124,108,255,.35)' }
          : { background: '#16161c', color: '#9a9aa3', border: '1px solid #26262e' }),
      }}
    >
      {planLabel(plan)}
    </span>
  );
}

// Usage vs a plan limit. `limit` null/Infinity renders as unlimited.
function Meter({ used, limit, noun }: { used: number; limit: number | null; noun: string }): React.ReactElement {
  const unlimited = teams.isUnlimited(limit);
  const cap = unlimited ? 0 : (limit as number);
  const pct = unlimited ? 0 : Math.min(100, cap > 0 ? (used / cap) * 100 : 100);
  const full = !unlimited && used >= cap;
  const near = !unlimited && !full && pct >= 80;
  const colour = full ? RED : near ? '#ffb020' : V.accent;
  return (
    <div style={{ flex: 1, minWidth: 150 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: full ? RED : '#ededf0' }}>{used}</span>
        <span style={{ fontSize: 11.5, color: '#6a6a74' }}>{unlimited ? noun + ' · unlimited' : `of ${cap} ${noun}`}</span>
      </div>
      <div style={{ height: 4, borderRadius: 999, background: '#18181f', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: unlimited ? '100%' : pct + '%', borderRadius: 999, background: unlimited ? V.grad : colour, opacity: unlimited ? 0.35 : 1, transition: 'width .3s ease' }} />
      </div>
    </div>
  );
}

export default function TeamsPanel({ isTauri, defaults, onRemember, onSync, onGoDashboard, onTeamContext, onSignedOut, openExt }: Props): React.ReactElement {
  const [email, setEmail] = useState(defaults.email || '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const [signedIn, setSignedIn] = useState(teams.isSignedIn());
  const [memberships, setMemberships] = useState<teams.Membership[]>(teams.currentMemberships());
  const [teamId, setTeamId] = useState('');
  const [conns, setConns] = useState<teams.TeamConn[]>([]);
  const [connErr, setConnErr] = useState('');
  const [activity, setActivity] = useState<Record<string, { lastUsedAt: string; actorName: string }>>({});
  const [linking, setLinking] = useState<{ code: string; linkId: string } | null>(null);
  const [linkErr, setLinkErr] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  // Team management (all in the app now).
  const [members, setMembers] = useState<teams.TeamMember[]>([]);
  const [teamInvites, setTeamInvites] = useState<teams.TeamInvite[]>([]);
  const [myInvites, setMyInvites] = useState<teams.MyInvite[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('MEMBER');
  const [newTeamName, setNewTeamName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [mgmtBusy, setMgmtBusy] = useState(false);
  const [mgmtMsg, setMgmtMsg] = useState('');
  // Billing (server-authoritative).
  const [sub, setSub] = useState<teams.Subscription | null>(null);
  const [ent, setEnt] = useState<teams.Entitlements | null>(null);
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingErr, setBillingErr] = useState('');
  const [showPlans, setShowPlans] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const membership = memberships.find((m) => m.teamId === teamId);
  const role = membership?.role ?? '';
  const canManage = role === 'OWNER' || role === 'ADMIN';
  const isOwner = role === 'OWNER';
  const isPersonalTeam = !!membership?.isPersonal;
  // The subscription endpoint is authoritative; the membership's tier is the pre-fetch fallback.
  const plan = (sub?.plan ?? membership?.planTier ?? 'FREE').toUpperCase();
  const openUrl = (url: string): void => {
    if (openExt) openExt(url);
    else if (isTauri) void invoke('open_url', { url }).catch(() => {});
    else window.open(url, '_blank', 'noopener');
  };

  // Auto-sync team connections into the local vault (no manual import). Runs after sign-in/link.
  async function runSync(force?: boolean): Promise<void> {
    setSyncing(true);
    setSyncMsg('');
    try {
      const n = await onSync(force);
      setSyncMsg(n ? `Synced ${n} connection${n === 1 ? '' : 's'} — they're in your Connections list.` : 'Connections are up to date.');
    } catch {
      setSyncMsg('Sync failed — try again.');
    } finally {
      setSyncing(false);
    }
  }

  // On (re)mount while already signed in — e.g. returning to Teams after importing a connection
  // and visiting the Dashboard — the vault persists in the client module but this component's
  // team/connection state was reset, which rendered a blank Teams view. Restore + reload here.
  useEffect(() => {
    if (!signedIn || teamId) return;
    void (async () => {
      let ms = teams.currentMemberships();
      if (!ms.length) {
        try {
          ms = await teams.loadMemberships();
        } catch {
          return;
        }
      }
      setMemberships(ms);
      if (ms.length) void loadTeam(ms.find((m) => !m.isPersonal)?.teamId ?? ms[0].teamId);
      void runSync(); void loadMyInvites();
    })();
  }, []);

  // Device linking: open the web app in the browser, sign in / approve there, then unseal the
  // identity locally — no email/password is ever typed in the app.
  async function startLinkFlow(): Promise<void> {
    setLinkErr('');
    if (pollRef.current) clearInterval(pollRef.current);
    try {
      const { linkId, code, approveUrl } = await teams.startLink();
      onRemember(email.trim());
      setLinking({ code, linkId });
      openUrl(approveUrl);
      let tries = 0;
      pollRef.current = setInterval(() => {
        tries += 1;
        void (async () => {
          try {
            const r = await teams.claimLink(linkId);
            if (r.status === 'linked') {
              if (pollRef.current) clearInterval(pollRef.current);
              setLinking(null);
              setSignedIn(true);
              setMemberships(r.memberships ?? []);
              const ms = r.memberships ?? [];
              if (ms.length) void loadTeam(ms.find((m) => !m.isPersonal)?.teamId ?? ms[0].teamId);
              void runSync(); void loadMyInvites();
            } else if (r.status === 'expired' || r.status === 'claimed') {
              if (pollRef.current) clearInterval(pollRef.current);
              setLinking(null);
              setLinkErr('The link expired before it was approved. Try again.');
            }
          } catch {
            /* transient — keep polling */
          }
        })();
        if (tries > 150) {
          if (pollRef.current) clearInterval(pollRef.current);
          setLinking(null);
          setLinkErr('Timed out waiting for approval. Try again.');
        }
      }, 2000);
    } catch (e: any) {
      setLinkErr(e?.message ?? String(e));
    }
  }
  function cancelLink(): void {
    if (pollRef.current) clearInterval(pollRef.current);
    setLinking(null);
  }

  async function doSignIn(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const { memberships: ms } = await teams.signIn(email.trim(), password);
      onRemember(email.trim());
      setPassword('');
      setSignedIn(true);
      setMemberships(ms);
      if (ms.length) void loadTeam(ms.find((m) => !m.isPersonal)?.teamId ?? ms[0].teamId);
      void runSync(); void loadMyInvites();
    } catch (e2: any) {
      setErr(e2?.message ?? String(e2));
    } finally {
      setBusy(false);
    }
  }

  // Plan + seat state for the selected team. Best-effort: a server without billing configured
  // still renders the plan from the membership.
  async function loadBilling(id: string): Promise<void> {
    setSub(null);
    setEnt(null);
    setBillingErr('');
    const [s, e] = await Promise.allSettled([teams.getSubscription(id), teams.getEntitlements(id)]);
    if (s.status === 'fulfilled') setSub(s.value);
    if (e.status === 'fulfilled') setEnt(e.value);
  }

  async function loadTeam(id: string): Promise<void> {
    setTeamId(id);
    onTeamContext?.(id);
    setConnErr('');
    setConns([]);
    setActivity({});
    setMembers([]);
    setTeamInvites([]);
    setMgmtMsg('');
    void loadBilling(id);
    try {
      setConns(await teams.listConnections(id));
    } catch (e: any) {
      setConnErr(e?.message ?? String(e));
    }
    const r = teams.currentMemberships().find((m) => m.teamId === id)?.role ?? '';
    // Members (any member); activity + pending invites (admin/auditor).
    try {
      setMembers(await teams.listMembers(id));
    } catch {
      /* ignore */
    }
    if (['OWNER', 'ADMIN', 'AUDITOR'].includes(r)) {
      try {
        setActivity(await teams.listActivity(id));
      } catch {
        /* best-effort */
      }
    }
    if (r === 'OWNER' || r === 'ADMIN') {
      try {
        setTeamInvites(await teams.getTeamInvites(id));
      } catch {
        /* best-effort */
      }
    }
  }

  async function loadMyInvites(): Promise<void> {
    try {
      setMyInvites(await teams.listMyInvites());
    } catch {
      setMyInvites([]);
    }
  }

  // ---- billing actions ----
  // Checkout and the customer portal both happen in the browser — the app never touches card data.
  async function doUpgrade(target: 'PRO' | 'ENTERPRISE'): Promise<void> {
    setBillingBusy(true);
    setBillingErr('');
    try {
      openUrl(await teams.startCheckout(teamId, target));
    } catch (e: any) {
      setBillingErr(e?.message ?? String(e));
    } finally {
      setBillingBusy(false);
    }
  }
  async function doPortal(): Promise<void> {
    setBillingBusy(true);
    setBillingErr('');
    try {
      openUrl(await teams.billingPortal(teamId));
    } catch (e: any) {
      setBillingErr(e?.message ?? String(e));
    } finally {
      setBillingBusy(false);
    }
  }

  // ---- management actions ----
  async function createTeamNow(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const name = newTeamName.trim();
    if (!name) return;
    setMgmtBusy(true);
    setMgmtMsg('');
    try {
      const ms = await teams.createTeam(name);
      setMemberships(ms);
      setNewTeamName('');
      setShowCreate(false);
      const created = ms.find((m) => m.teamName === name);
      if (created) await loadTeam(created.teamId);
      setMgmtMsg(`Created "${name}".`);
    } catch (e2: any) {
      setMgmtMsg(e2?.message ?? String(e2));
    } finally {
      setMgmtBusy(false);
    }
  }
  async function doInvite(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setMgmtBusy(true);
    setMgmtMsg('');
    try {
      const code = await teams.inviteMember(teamId, inviteEmail.trim(), inviteRole);
      setInviteEmail('');
      setMgmtMsg(`Invited. Share this code so they can join: ${code}`);
      setTeamInvites(await teams.getTeamInvites(teamId));
      setMembers(await teams.listMembers(teamId));
    } catch (e2: any) {
      setMgmtMsg(e2?.message ?? String(e2));
    } finally {
      setMgmtBusy(false);
    }
  }
  async function doShareKeys(): Promise<void> {
    setMgmtBusy(true);
    setMgmtMsg('');
    try {
      const n = await teams.shareTeamKey(teamId);
      setMgmtMsg(`Team key shared with ${n} member${n === 1 ? '' : 's'} — they can now decrypt.`);
    } catch (e2: any) {
      setMgmtMsg(e2?.message ?? String(e2));
    } finally {
      setMgmtBusy(false);
    }
  }
  async function doRemove(memberId: string): Promise<void> {
    setMgmtBusy(true);
    try {
      await teams.removeMember(teamId, memberId);
      setMembers(await teams.listMembers(teamId));
      void loadBilling(teamId); // seat count changed → refresh what's billable
    } catch (e2: any) {
      setMgmtMsg(e2?.message ?? String(e2));
    } finally {
      setMgmtBusy(false);
    }
  }
  async function doChangeRole(memberId: string, next: string): Promise<void> {
    setMgmtBusy(true);
    setMgmtMsg('');
    try {
      await teams.changeMemberRole(teamId, memberId, next);
      setMembers(await teams.listMembers(teamId));
    } catch (e2: any) {
      setMgmtMsg(e2?.message ?? String(e2));
    } finally {
      setMgmtBusy(false);
    }
  }
  async function afterLeaveOrDelete(ms: teams.Membership[]): Promise<void> {
    setMemberships(ms);
    const next = ms.find((m) => !m.isPersonal)?.teamId ?? ms[0]?.teamId ?? '';
    setTeamId(next);
    onTeamContext?.(next);
    if (next) void loadTeam(next); else setMembers([]);
    void onSync(true); // re-sync so the removed team's connections are pruned locally
  }
  async function doLeave(): Promise<void> {
    if (!window.confirm('Leave this team? You’ll lose access to its shared connections.')) return;
    setMgmtBusy(true);
    try { await afterLeaveOrDelete(await teams.leaveTeam(teamId)); }
    catch (e2: any) { setMgmtMsg(e2?.message ?? String(e2)); }
    finally { setMgmtBusy(false); }
  }
  async function doDelete(): Promise<void> {
    if (!window.confirm('Delete this team for everyone? This removes all its shared connections and can’t be undone.')) return;
    setMgmtBusy(true);
    try { await afterLeaveOrDelete(await teams.deleteTeam(teamId)); }
    catch (e2: any) { setMgmtMsg(e2?.message ?? String(e2)); }
    finally { setMgmtBusy(false); }
  }
  async function actInvite(id: string, kind: 'accept' | 'reject'): Promise<void> {
    setMgmtBusy(true);
    try {
      if (kind === 'accept') {
        const ms = await teams.acceptInvite(id);
        setMemberships(ms);
        void runSync(true);
      } else {
        await teams.rejectInvite(id);
      }
      await loadMyInvites();
    } catch (e2: any) {
      setMgmtMsg(e2?.message ?? String(e2));
    } finally {
      setMgmtBusy(false);
    }
  }

  // Signing out drops the in-memory vault AND the keychain entry that keeps this device signed in.
  function signOut(): void {
    teams.signOut();
    setSignedIn(false);
    setMemberships([]);
    setConns([]);
    setTeamId('');
    setSub(null);
    setEnt(null);
    onTeamContext?.('');
    onSignedOut?.();
  }

  // ---- signed out: sell the product, then link the device -----------------
  if (!signedIn) {
    return (
      <div style={{ maxWidth: 860, margin: '8px auto 40px' }}>
        <div
          style={{
            ...card,
            padding: '30px 30px 26px',
            background: 'linear-gradient(180deg,rgba(124,108,255,.10),rgba(124,108,255,.01))',
            borderColor: V.line,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 22, fontWeight: 700, color: '#f2f2f5', letterSpacing: '-.02em' }}>SSH Ache</span>
            <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: '#fff', background: V.grad, borderRadius: 6, padding: '4px 10px', boxShadow: '0 3px 16px rgba(124,108,255,.4)' }}>Teams</span>
          </div>
          <p style={{ color: '#9a9aa3', margin: '12px 0 0', fontSize: 13, lineHeight: 1.65, maxWidth: 560 }}>
            Share SSH connections with your teammates, end-to-end encrypted. Everything is decrypted
            on this device — the server only ever stores ciphertext. <strong style={{ color: '#ededf0', fontWeight: 600 }}>Free for up to 2 members</strong>, then $2 per member/month.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: '20px 0 0', display: 'grid', gap: 10 }}>
            {[
              ['🔐', 'Shared connections, end-to-end encrypted — the server only stores ciphertext.'],
              ['🟢', "See who's online and watch a teammate's live session, Figma-style."],
              ['🎫', 'Grant per-connection access and revoke anyone in one click.'],
              ['☁️', 'Personal cloud vault — your own connections on every device you sign in on.'],
            ].map(([ic, t]) => (
              <li key={t} style={{ display: 'flex', gap: 11, alignItems: 'flex-start', fontSize: 12.5, color: '#9a9aa3' }}>
                <span style={{ flex: 'none' }}>{ic}</span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>

        {!isTauri && (
          <p style={{ color: '#8b8b95', fontSize: 12.5, marginTop: 14 }}>
            Note: imported credentials are stored in your OS keychain, which is only available in
            the desktop app.
          </p>
        )}

        {linking ? (
          <div style={{ ...card, marginTop: 14, textAlign: 'center' }}>
            <div style={{ fontSize: 12.5, color: '#9a9aa3', marginBottom: 12 }}>
              Approve in your browser to finish. Confirm this code matches the one shown there:
            </div>
            <div style={{ fontSize: 27, fontWeight: 700, letterSpacing: '.16em', color: V.accentHi, margin: '4px 0 14px' }}>{linking.code}</div>
            <div style={{ fontSize: 12, color: '#6a6a74' }}>Waiting for approval…</div>
            <div style={{ marginTop: 14 }}>
              <button style={btn()} onClick={cancelLink}>Cancel</button>
            </div>
          </div>
        ) : (
          <div style={{ ...card, marginTop: 14 }}>
            <p style={{ fontSize: 12.5, color: '#9a9aa3', margin: 0, lineHeight: 1.6 }}>
              We'll open the web app in your browser to sign in or create an account — no password
              typed here, and your keys never leave this device unencrypted.
            </p>
            {linkErr && <p style={{ color: RED, fontSize: 12.5, marginBottom: 0 }}>{linkErr}</p>}
            <div style={{ marginTop: 16, display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
              <button style={btn('primary')} onClick={() => void startLinkFlow()}>Connect via browser</button>
              <button style={btn()} onClick={() => openUrl('https://sshache.com/#pricing')}>See plans &amp; pricing</button>
            </div>
            <details style={{ marginTop: 18 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: '#6a6a74' }}>Sign in with email instead</summary>
              <form onSubmit={doSignIn} style={{ ...card, marginTop: 12, background: '#0e0e12' }}>
                <label style={{ ...label, marginTop: 0 }}>
                  Email
                  <input style={{ ...input, marginTop: 5 }} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
                </label>
                <label style={label}>
                  Password
                  <input style={{ ...input, marginTop: 5 }} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                </label>
                {err && <p style={{ color: RED, fontSize: 12.5, marginBottom: 0 }}>{err}</p>}
                <div style={{ marginTop: 16 }}>
                  <button type="submit" style={btn('primary')} disabled={busy || !email || !password}>
                    {busy ? 'Signing in…' : 'Sign in & unlock'}
                  </button>
                </div>
              </form>
            </details>
          </div>
        )}

        <div style={sectionTitle}>Plans</div>
        <PlanGrid current="" onPick={() => openUrl('https://sshache.com/#pricing')} pickLabel="See details" />
      </div>
    );
  }

  // ---- signed in ----------------------------------------------------------
  const memberCount = members.length;
  const connCount = conns.length;
  const limits = ent?.limits;
  const atMemberCap = !!limits && !teams.isUnlimited(limits.maxMembers) && memberCount >= (limits.maxMembers as number);
  const atConnCap = !!limits && !teams.isUnlimited(limits.maxConnections) && connCount >= (limits.maxConnections as number);

  return (
    <div style={{ maxWidth: 860, margin: '8px auto 40px' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: '#f2f2f5', letterSpacing: '-.01em' }}>Teams &amp; billing</span>
        <span style={{ flex: 1 }} />
        <button style={btn('primary')} disabled={syncing} onClick={() => void runSync(true)}>{syncing ? 'Syncing…' : '↻ Sync now'}</button>
        <button style={btn()} onClick={() => setShowCreate((v2) => !v2)}>+ New team</button>
        {/* Account: who this device is signed in as, and the way back out. */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px 5px 9px', border: '1px solid ' + V.line, background: V.soft, borderRadius: 999 }}>
          <span style={{ fontSize: 11.5, color: '#b9b9c2', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{teams.currentEmail() || 'Signed in'}</span>
          <button style={{ ...btn('danger'), padding: '5px 11px', fontSize: 11.5 }} onClick={signOut} title="Sign this account out of this device">Sign out</button>
        </span>
      </div>

      {showCreate && (
        <form onSubmit={createTeamNow} style={{ ...card, margin: '14px 0 0', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input style={{ ...input, flex: 1 }} value={newTeamName} onChange={(e) => setNewTeamName(e.target.value)} placeholder="Team name" />
          <button style={btn('primary')} type="submit" disabled={mgmtBusy || !newTeamName.trim()}>Create</button>
        </form>
      )}

      {myInvites.length > 0 && (
        <div style={{ ...card, margin: '16px 0 0', borderColor: V.line, background: V.soft }}>
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13, color: '#ededf0' }}>You've been invited</div>
          {myInvites.map((iv) => (
            <div key={iv.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '6px 0', fontSize: 13 }}>
              <span style={{ color: '#ededf0' }}>{iv.teamName} <span style={{ color: '#8b8b95', fontSize: 12 }}>· join as {iv.role.toLowerCase()}</span></span>
              <span style={{ display: 'flex', gap: 6 }}>
                <button style={btn('primary')} disabled={mgmtBusy} onClick={() => void actInvite(iv.id, 'accept')}>Join</button>
                <button style={btn()} disabled={mgmtBusy} onClick={() => void actInvite(iv.id, 'reject')}>Reject</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {memberships.length === 0 ? (
        <p style={{ color: '#8b8b95', marginTop: 20, fontSize: 13 }}>No teams yet. Create one above, or accept an invitation.</p>
      ) : (
        <>
          {/* team switcher — every team you're in, with its own plan */}
          <div style={sectionTitle}>Your teams ({memberships.length})</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {memberships.map((m) => {
              const on = m.teamId === teamId;
              return (
                <button
                  key={m.teamId}
                  onClick={() => void loadTeam(m.teamId)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    borderRadius: 9,
                    cursor: 'pointer',
                    font: 'inherit',
                    fontSize: 12.5,
                    color: on ? '#ededf0' : '#9a9aa3',
                    background: on ? V.soft : '#0e0e12',
                    border: '1px solid ' + (on ? V.line : '#20202a'),
                  }}
                >
                  <span style={{ color: on ? V.accentHi : '#54545e' }}>{m.isPersonal ? '☁' : '◈'}</span>
                  <span style={{ fontWeight: on ? 600 : 500 }}>{m.teamName}</span>
                  <span style={{ color: '#6a6a74', fontSize: 11 }}>{m.role.toLowerCase()}</span>
                  {!m.isPersonal && <PlanChip plan={String(m.planTier || 'FREE').toUpperCase()} />}
                </button>
              );
            })}
          </div>

          {/* current team + plan */}
          {teamId && (
            <>
              <div style={sectionTitle}>Current {isPersonalTeam ? 'vault' : 'team'}</div>
              <div style={{ ...card, borderColor: V.line, background: 'linear-gradient(180deg,rgba(124,108,255,.07),rgba(124,108,255,.005))' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 19, fontWeight: 700, color: '#f2f2f5', letterSpacing: '-.01em' }}>{membership?.teamName}</span>
                  {!isPersonalTeam && <PlanChip plan={plan} size="lg" />}
                  <span style={{ fontSize: 11.5, color: '#6a6a74', border: '1px solid #26262e', borderRadius: 999, padding: '3px 9px' }}>you are {role.toLowerCase()}</span>
                  <span style={{ flex: 1 }} />
                  <button style={btn()} onClick={onGoDashboard}>Open Connections →</button>
                </div>

                {isPersonalTeam ? (
                  <p style={{ fontSize: 12.5, color: '#8b8b95', margin: '14px 0 0', lineHeight: 1.6 }}>
                    Your personal cloud vault — a private, single-member space that syncs your own
                    connections to every device you sign in on. It isn't billed and can't be shared.
                  </p>
                ) : (
                  <>
                    {/* usage vs plan limits */}
                    <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 18 }}>
                      <Meter used={memberCount} limit={limits ? limits.maxMembers : null} noun="members" />
                      <Meter used={connCount} limit={limits ? limits.maxConnections : null} noun="shared connections" />
                    </div>

                    {/* seats + renewal */}
                    <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', marginTop: 18, paddingTop: 16, borderTop: '1px solid #1a1a22' }}>
                      {[
                        ['Billable seats', plan === 'FREE' ? 'none — Free plan' : String(sub?.billableSeats ?? 0)],
                        ['Status', (sub?.status ?? 'ACTIVE').toLowerCase()],
                        [sub?.cancelAtPeriodEnd ? 'Access ends' : 'Renews', plan === 'FREE' ? 'never — $0 forever' : dateLabel(sub?.currentPeriodEnd ?? null)],
                        ['Audit retention', limits ? (teams.isUnlimited(limits.auditRetentionDays) ? 'unlimited' : `${limits.auditRetentionDays} days`) : '—'],
                      ].map(([k, val]) => (
                        <div key={k}>
                          <div style={{ fontSize: 9.5, letterSpacing: '.12em', textTransform: 'uppercase', color: '#54545e' }}>{k}</div>
                          <div style={{ fontSize: 13, color: '#ededf0', marginTop: 4, fontWeight: 600 }}>{val}</div>
                        </div>
                      ))}
                    </div>

                    {sub?.cancelAtPeriodEnd && (
                      <div style={{ marginTop: 14, padding: '10px 13px', borderRadius: 9, background: 'rgba(255,176,32,.09)', border: '1px solid rgba(255,176,32,.3)', fontSize: 12.5, color: '#ffb020' }}>
                        Subscription is set to cancel — this team drops to the Free plan (2 members, 5 connections) on {dateLabel(sub.currentPeriodEnd)}.
                      </div>
                    )}
                    {(atMemberCap || atConnCap) && plan === 'FREE' && (
                      <div style={{ marginTop: 14, padding: '10px 13px', borderRadius: 9, background: 'rgba(255,107,120,.09)', border: '1px solid rgba(255,107,120,.3)', fontSize: 12.5, color: RED }}>
                        You've hit the Free plan {atMemberCap && atConnCap ? 'member and connection limits' : atMemberCap ? 'member limit' : 'connection limit'}. Upgrade to Pro for unlimited {atMemberCap && atConnCap ? 'members and connections' : atMemberCap ? 'members' : 'connections'}.
                      </div>
                    )}

                    {/* billing actions — role-gated exactly as the API is */}
                    <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginTop: 18 }}>
                      {isOwner && plan === 'FREE' && (
                        <button style={btn('primary')} disabled={billingBusy} onClick={() => void doUpgrade('PRO')}>↑ Upgrade to Pro — $2/member/mo</button>
                      )}
                      {isOwner && plan === 'PRO' && (
                        <button style={btn('primary')} disabled={billingBusy} onClick={() => void doUpgrade('ENTERPRISE')}>↑ Upgrade to Enterprise</button>
                      )}
                      {canManage && plan !== 'FREE' && (
                        <button style={btn()} disabled={billingBusy} onClick={() => void doPortal()}>Manage billing &amp; invoices</button>
                      )}
                      <button style={btn()} onClick={() => setShowPlans((v2) => !v2)}>{showPlans ? 'Hide plans' : 'Compare plans'}</button>
                      {!isOwner && plan === 'FREE' && (
                        <span style={{ fontSize: 12, color: '#6a6a74', alignSelf: 'center' }}>Only the team owner can change the plan.</span>
                      )}
                    </div>
                    {billingErr && <p style={{ color: RED, fontSize: 12.5, margin: '10px 0 0' }}>{billingErr}</p>}
                  </>
                )}
              </div>

              {showPlans && !isPersonalTeam && (
                <div style={{ marginTop: 12 }}>
                  <PlanGrid
                    current={plan}
                    onPick={(id) => {
                      if (id === 'FREE') return;
                      if (isOwner) void doUpgrade(id as 'PRO' | 'ENTERPRISE');
                      else openUrl('https://sshache.com/#pricing');
                    }}
                    pickLabel={isOwner ? 'Upgrade' : 'See details'}
                  />
                  <p style={{ fontSize: 11.5, color: '#54545e', margin: '10px 2px 0', lineHeight: 1.6 }}>
                    Pro bills only past the first 2 members — a 5-person team is $6/month. Checkout and
                    invoices open in your browser; the app never handles card details.
                  </p>
                </div>
              )}
            </>
          )}

          {connErr && <p style={{ color: RED, fontSize: 12.5, marginTop: 12 }}>{connErr}</p>}
          {syncMsg && <p style={{ color: GREEN, fontSize: 12.5, marginTop: 12 }}>{syncMsg}</p>}

          {/* shared connections */}
          {teamId && (
            <>
              <div style={sectionTitle}>Shared connections ({connCount})</div>
              <p style={{ color: '#6a6a74', fontSize: 12, margin: '0 0 10px' }}>
                These sync into your Connections list automatically — no import needed.
              </p>
              {!connErr && connCount === 0 && (
                <p style={{ color: '#6a6a74', fontSize: 12.5 }}>Nothing shared in this {isPersonalTeam ? 'vault' : 'team'} yet.</p>
              )}
              <div style={{ display: 'grid', gap: 8 }}>
                {conns.map((c) => (
                  <div key={c.id} style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 15px', gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: '#ededf0' }}>{c.meta.name}</div>
                      <div style={{ color: '#6a6a74', fontSize: 12, marginTop: 2 }}>
                        {c.meta.user}@{c.meta.host}:{c.meta.port} · {c.meta.auth}
                      </div>
                      {activity[c.id] && (
                        <div style={{ color: GREEN, fontSize: 11.5, marginTop: 3 }}>
                          Last used {timeAgo(activity[c.id]!.lastUsedAt)} · {activity[c.id]!.actorName}
                        </div>
                      )}
                    </div>
                    <span style={{ color: GREEN, fontSize: 12, fontWeight: 600, flex: 'none' }}>✓ Synced</span>
                  </div>
                ))}
              </div>

              {/* members + management */}
              <div style={sectionTitle}>Members ({memberCount})</div>
              <div style={card}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginBottom: members.length ? 12 : 0, flexWrap: 'wrap' }}>
                  {canManage && <button style={btn()} disabled={mgmtBusy} onClick={() => void doShareKeys()} title="Wrap the team key to every member so they can decrypt">🔑 Share keys</button>}
                  {!isPersonalTeam && <button style={btn('danger')} disabled={mgmtBusy} onClick={() => void doLeave()} title="Leave this team">Leave</button>}
                  {isOwner && !isPersonalTeam && <button style={btn('danger')} disabled={mgmtBusy} onClick={() => void doDelete()} title="Delete this team for everyone">Delete team</button>}
                </div>
                {members.map((m) => (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderTop: '1px solid #16161c', fontSize: 13 }}>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#ededf0' }}>
                      {m.displayName} <span style={{ color: '#6a6a74', fontSize: 12 }}>· {m.email}</span>
                    </span>
                    <span style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 'none' }}>
                      {canManage && m.role !== 'OWNER' && m.userId !== teams.currentUserId() ? (
                        <select
                          style={{ ...input, width: 'auto', padding: '4px 7px', fontSize: 11.5 }}
                          value={m.role}
                          disabled={mgmtBusy}
                          onChange={(e) => void doChangeRole(m.id, e.target.value)}
                        >
                          <option value="MEMBER">member</option>
                          <option value="ADMIN">admin</option>
                          {ent?.features?.roles === 'rbac' && <option value="AUDITOR">auditor</option>}
                        </select>
                      ) : (
                        <span style={{ color: '#6a6a74', fontSize: 11.5 }}>{m.role.toLowerCase()}</span>
                      )}
                      {canManage && m.role !== 'OWNER' && m.userId !== teams.currentUserId() && (
                        <button style={{ ...btn('danger'), padding: '5px 10px', fontSize: 11.5 }} disabled={mgmtBusy} onClick={() => void doRemove(m.id)}>Remove</button>
                      )}
                    </span>
                  </div>
                ))}
              </div>

              {canManage && !isPersonalTeam && (
                <div style={{ ...card, marginTop: 12 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 13, color: '#ededf0' }}>Invite a member</div>
                  <div style={{ fontSize: 11.5, color: '#6a6a74', marginBottom: 11 }}>
                    {plan === 'FREE'
                      ? `Free plan: ${memberCount} of ${limits && !teams.isUnlimited(limits.maxMembers) ? limits.maxMembers : 2} seats used.`
                      : `Each member past the first 2 adds $${plan === 'ENTERPRISE' ? 3 : 2}/month.`}
                  </div>
                  <form onSubmit={doInvite} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input style={{ ...input, flex: 1, minWidth: 180 }} type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="teammate@company.dev" />
                    <select style={{ ...input, width: 'auto' }} value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                      <option value="MEMBER">Member</option>
                      <option value="ADMIN">Admin</option>
                      {ent?.features?.roles === 'rbac' && <option value="AUDITOR">Auditor</option>}
                    </select>
                    <button style={btn('primary')} type="submit" disabled={mgmtBusy || !inviteEmail.trim() || atMemberCap}>Invite</button>
                  </form>
                  {atMemberCap && (
                    <p style={{ fontSize: 12, color: RED, margin: '10px 0 0' }}>
                      Seat limit reached on the {planLabel(plan)} plan.{isOwner ? ' Upgrade to Pro to invite more people.' : ' Ask the team owner to upgrade.'}
                    </p>
                  )}
                  {teamInvites.length > 0 && (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ color: '#54545e', fontSize: 11, marginBottom: 6, letterSpacing: '.1em', textTransform: 'uppercase' }}>Pending invitations</div>
                      {teamInvites.map((iv) => (
                        <div key={iv.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '4px 0', fontSize: 12.5 }}>
                          <span style={{ color: '#b9b9c2' }}>{iv.email} <span style={{ color: '#6a6a74' }}>· {iv.role.toLowerCase()}</span></span>
                          {iv.code && <code style={{ color: V.accentHi, fontSize: 12 }}>{iv.code}</code>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {mgmtMsg && <p style={{ color: GREEN, fontSize: 12.5, wordBreak: 'break-all', marginTop: 12 }}>{mgmtMsg}</p>}
            </>
          )}
        </>
      )}
    </div>
  );
}

// The three packages, side by side. `current` highlights the team's plan; picking a higher one
// starts checkout (owner) or opens the pricing page.
function PlanGrid({ current, onPick, pickLabel }: { current: string; onPick: (id: string) => void; pickLabel: string }): React.ReactElement {
  const order = PLANS.map((p) => p.id as string);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: 10 }}>
      {PLANS.map((p) => {
        const on = p.id === current;
        const higher = current ? order.indexOf(p.id) > order.indexOf(current) : false;
        return (
          <div
            key={p.id}
            style={{
              ...card,
              padding: 17,
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              borderColor: on ? V.line : '#1e1e26',
              background: on ? 'linear-gradient(180deg,rgba(124,108,255,.10),rgba(124,108,255,.01))' : '#0c0c10',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: '#f2f2f5' }}>{p.name}</span>
              {on ? (
                <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: '#fff', background: V.grad, borderRadius: 999, padding: '2px 7px' }}>Current</span>
              ) : (
                <span style={{ fontSize: 10.5, color: '#54545e' }}>{p.tag}</span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginTop: 6 }}>
              <span style={{ fontSize: 22, fontWeight: 700, color: '#f2f2f5', letterSpacing: '-.02em' }}>{p.price}</span>
              <span style={{ fontSize: 10.5, color: '#6a6a74' }}>{p.unit}</span>
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: '13px 0 0', display: 'grid', gap: 7 }}>
              {p.perks.map((f) => (
                <li key={f} style={{ display: 'flex', gap: 8, fontSize: 11.5, color: '#9a9aa3', lineHeight: 1.45 }}>
                  <span style={{ color: on ? V.accentHi : '#46464f', flex: 'none' }}>✓</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <span style={{ flex: 1 }} />
            {!on && (higher || !current) && (
              <button style={{ ...btn(higher ? 'primary' : 'ghost'), marginTop: 15, width: '100%' }} onClick={() => onPick(p.id)}>
                {higher ? `${pickLabel} to ${p.name}` : pickLabel}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
