/**
 * POST /api/auth/logout
 * Clears session cookie and deletes session from KV.
 */
import { json, corsPreflightResponse, getKV } from '../../_lib/helpers.js';

export async function onRequestPost(context) {
  const kv = getKV(context.env);
  const cookie = context.request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([a-f0-9]+)/);

  if (match && kv) {
    try {
      await kv.delete(`session:${match[1]}`);
    } catch {
      // Ignore — session may have already expired
    }
  }

  return json(
    { success: true },
    200,
    { 'Set-Cookie': 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' }
  );
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}
