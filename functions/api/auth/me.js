/**
 * GET /api/auth/me
 * Returns current user info from session cookie.
 */
import { json, err, corsPreflightResponse, getSession, getKV } from '../../_lib/helpers.js';

export async function onRequestGet(context) {
  const kv = getKV(context.env);
  if (!kv) return err('Storage not configured', 500);

  const session = await getSession(kv, context.request);
  if (!session) return err('Not authenticated', 401);

  const user = await kv.get(`user:${session.email}`, { type: 'json' });
  if (!user) return err('User not found', 404);

  return json({
    email: user.email,
    plan: user.plan,
    created_at: user.created_at,
  });
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}
