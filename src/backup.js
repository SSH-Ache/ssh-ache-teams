// Encrypted backup / export format (Web Crypto: PBKDF2-SHA256 → AES-256-GCM).
// Lives outside App.tsx so `npm test` can exercise it in plain Node.

// Chunked: btoa(String.fromCharCode(...bytes)) blows the argument limit
// (RangeError) somewhere past ~64 KB — i.e. on the vaults with the most keys.
export const b64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
};
export const ub64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// OWASP's floor for PBKDF2-HMAC-SHA256 (since 2023). Older exports carry their
// own `iter`, so they still open.
export const PBKDF2_ITER = 600000;

export const deriveKey = async (password, salt, iter = PBKDF2_ITER) => {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
};

export const encryptJson = async (obj, password) => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return JSON.stringify({ app: "ssh-ache", v: 1, kdf: "PBKDF2-SHA256", iter: PBKDF2_ITER, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) });
};

export const decryptJson = async (envelope, password) => {
  const e = JSON.parse(envelope);
  if (e.kdf && e.kdf !== "PBKDF2-SHA256") throw new Error("unsupported key derivation: " + e.kdf);
  // Read the iteration count the file was written with — older exports used
  // 200k, so bumping the default must not lock them out.
  const key = await deriveKey(password, ub64(e.salt), Number(e.iter) || 200000);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(e.iv) }, key, ub64(e.ct));
  return JSON.parse(new TextDecoder().decode(pt));
};

// Fields an imported connection file is allowed to set. Anything else in the
// file is dropped — notably agentAllowed / agentAutoAllow, so a shared file can
// never arrive with AI-agent access pre-granted.
export const HOST_FIELDS = ['name', 'addr', 'user', 'port', 'folder', 'tags', 'auth', 'keyMode', 'keyPath', 'vaultKeyId', 'jumpHost', 'snippet', 'favorite'];

export const pickHostFields = (h) => {
  const out = {};
  for (const k of HOST_FIELDS) if (h && h[k] !== undefined) out[k] = h[k];
  out.tags = Array.isArray(out.tags) ? out.tags : [];
  return out;
};
