/**
 * Shared helpers for Cloudflare Pages Functions
 * Password hashing (PBKDF2), session management, CORS, JSON responses
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Credentials': 'true',
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders },
  });
}

export function err(message, status = 400) {
  return json({ error: message }, status);
}

export function corsPreflightResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

// ── Password hashing (Web Crypto PBKDF2) ─────────────────

export async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

// ── ID generation ─────────────────────────────────────────

export function generateId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Session management ────────────────────────────────────

export async function createSession(kv, email) {
  const sessionId = generateId();
  const session = { email, created_at: new Date().toISOString() };
  await kv.put(`session:${sessionId}`, JSON.stringify(session), {
    expirationTtl: 86400 * 30, // 30 days
  });
  return sessionId;
}

export async function getSession(kv, request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([a-f0-9]+)/);
  if (!match) return null;
  try {
    const data = await kv.get(`session:${match[1]}`, { type: 'json' });
    return data;
  } catch {
    return null;
  }
}

export function sessionCookie(sessionId, maxAge = 86400 * 30) {
  return `session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

// ── KV helper ─────────────────────────────────────────────

export function getKV(env) {
  return env.DATA || env.LEADS || null;
}

// ── HTML escaping ─────────────────────────────────────────

export function esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
