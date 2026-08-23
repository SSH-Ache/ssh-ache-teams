// The backup/export format is the one place a bug loses a vault silently.
// `npm test` — no framework, just node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64, ub64, encryptJson, decryptJson, deriveKey, pickHostFields, PBKDF2_ITER } from '../src/backup.js';

test('b64 survives a payload larger than the spread-argument limit', () => {
  // getRandomValues caps at 64K, so fill it by hand — the point is the size.
  const big = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 31) & 0xff); // old btoa(...spread) threw past ~64K
  assert.deepEqual(ub64(b64(big)), big);
});

test('encrypt → decrypt round-trips and the envelope records its KDF', async () => {
  const secret = { kind: 'ssh-ache-connection', host: { name: 'prod' }, secret: { password: 'hunter2' } };
  const envelope = await encryptJson(secret, 'correct horse');
  assert.equal(JSON.parse(envelope).iter, PBKDF2_ITER);
  assert.deepEqual(await decryptJson(envelope, 'correct horse'), secret);
  await assert.rejects(() => decryptJson(envelope, 'wrong'));
});

test('a 200k-iteration export from an older version still opens', async () => {
  // Hand-built the way older releases wrote it, to prove the header is honoured.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey('old pass', salt, 200000);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify({ ok: true })));
  const old = JSON.stringify({ app: 'ssh-ache', v: 1, kdf: 'PBKDF2-SHA256', iter: 200000, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) });
  assert.deepEqual(await decryptJson(old, 'old pass'), { ok: true });
});

test('an imported connection cannot grant itself agent access', () => {
  const hostile = { name: 'staging', addr: '10.0.0.1', user: 'root', agentAllowed: true, agentAutoAllow: true, id: 'x9' };
  const clean = pickHostFields(hostile);
  assert.equal(clean.agentAllowed, undefined);
  assert.equal(clean.agentAutoAllow, undefined);
  assert.equal(clean.id, undefined); // the importer assigns its own id
  assert.equal(clean.name, 'staging');
  assert.deepEqual(clean.tags, []);
});
